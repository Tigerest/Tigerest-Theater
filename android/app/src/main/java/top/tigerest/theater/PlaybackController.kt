package top.tigerest.theater

import android.content.Context
import android.content.BroadcastReceiver
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.os.Handler
import android.os.Looper
import android.view.Surface
import `is`.xyz.mpv.MPVLib
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.thread
import kotlin.concurrent.withLock

class PlaybackController(private val context: Context, private val settings: SettingsStore) : MPVLib.EventObserver, MPVLib.LogObserver {
    val state = PlaybackState()
    private val temporarySpeed = TemporaryPlaybackSpeed()
    val temporarySpeedActive get() = temporarySpeed.active
    private val main = Handler(Looper.getMainLooper())
    private val starts = ConcurrentLinkedQueue<Long>()
    @Volatile private var eventGeneration = 0L
    @Volatile private var destroyed = false
    // Only a file mpv actually starts is queued for its START_FILE event.
    private val surfaceGate = VideoSurfaceGate { generation, url ->
        if(!destroyed && state.active && generation == state.generation) { starts.add(generation); MPVLib.command(arrayOf("loadfile",url,"replace")) }
    }
    private var surfaceDimensions = ""
    private val danmakuClock = DanmakuClock()
    @Volatile private var clockEpoch = 0L
    @Volatile var pauseIntent = 0L; private set
    private val resizeOutput = Runnable {
        // MediaCodec output is scaled by the compositor; reopening it would restart the decoder.
        if(!destroyed && surfaceGate.hasSurface && state.active && video && !hdrOutput) {
            // Recreate EGL after the Android buffer queue settles. A size property update alone
            // can leave the old buffer geometry visible on a paused, resized SurfaceView.
            DiagnosticsLog.app.record("info","Video output rebuilt for surface $surfaceDimensions")
            MPVLib.setPropertyString("vo","null")
            MPVLib.setPropertyString("vo",videoOutput())
        }
    }
    // HDR media decodes straight into the SurfaceView, so Android composes it as
    // HDR or Dolby Vision at the panel's brightness. mpv's OpenGL ES output can
    // only tone map to SDR; on this path mpv draws no subtitles or OSD.
    private var hdrOutput = false
    private fun videoOutput() = if (hdrOutput) "mediacodec_embed" else "gpu"
    private fun hardwareDecoding() = if (hdrOutput) "mediacodec"
        else when(settings.string("video","hardwareDecoding")){"disabled"->"no";"copy"->"mediacodec-copy";else->"mediacodec,mediacodec-copy"}
    private var video = true
    private var durationMs = 0L
    private var metadata = JSONObject()
    private var queued = JSONArray()
    private var currentId = ""
    private var subtitle: Any = -1
    private var audio: Any = 1
    private var startMs = 0.0
    // The item whose file is loaded: its tracks can be selected.
    private var loadedGeneration = 0L
    // Emby's intro marker from the page (setIntroSkip) and the "跳过片头" offer.
    private val introSkip = IntroSkip()
    private val introSeekTimeout = Runnable { introSkip.seekTimedOut() }
    // mpv's SEEK and PLAYBACK_RESTART events, reported to the page as on the desktop.
    private var seeking = false
    // External subtitles mpv fetches on a worker thread. A video that starts with one
    // waits for it, at most HOLD_MS, paused by this hold rather than by the viewer;
    // `play` is how the item starts once the hold ends.
    private val externalSubtitles = ExternalSubtitles()
    private class Hold(val generation: Long, var play: Boolean)
    private var hold: Hold? = null
    private val holdTimeout = Runnable { startWithoutSubtitle() }
    // Fetches inside mpv; mpv must outlive them (see destroy).
    private val fetchLock = ReentrantLock()
    private val fetchDone = fetchLock.newCondition()
    private var fetching = 0
    var signal: (String, JSONArray) -> Unit = { _, _ -> }
    var visible: (Boolean) -> Unit = {}
    var itemChanged: (JSONObject) -> Unit = {}
    var message: (String) -> Unit = {}
    /** Text over the video for a time in ms: the page's showMessage and the player's own notices; also shown on HDR output. */
    var notice: (String, Long) -> Unit = { _, _ -> }
    /** The "跳过片头" button is offered, or no longer. */
    var introSkipChanged: (Boolean) -> Unit = {}
    var subtitleText: (String) -> Unit = {}
    /** The playback-start HDR/SDR notice. */
    var dynamicRange: (String) -> Unit = {}
    /** HDR output only helps a panel that can show it; elsewhere mpv's tone mapping looks better and keeps subtitles. */
    var displayHdr: () -> Boolean = { false }
    private var rangeReported = false
    /** Video aspect for native layers; embedded is true while MediaCodec draws to the whole surface. */
    var videoLayout: (aspect: Double, embedded: Boolean) -> Unit = { _, _ -> }
    private var videoAspect = 0.0
    private val audioManager = context.getSystemService(AudioManager::class.java)
    private val mediaSession = MediaSession(context,"Tigerest MPV")
    private var pausedByFocus = false
    private val noisyReceiver = object: BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if(intent.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY && state.active) {
                DiagnosticsLog.app.record("info","Audio output became noisy (headphones or Bluetooth disconnected), pausing")
                endTemporarySpeed()
                pauseIntent++
                pausedByFocus = false
                setPaused(true)
            }
        }
    }
    private val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MOVIE).build())
        .setOnAudioFocusChangeListener({ change ->
            if (change < 0 && state.active) { DiagnosticsLog.app.record("info","Audio focus lost ($change), pausing"); endTemporarySpeed(); pauseIntent++; if(!isPaused()) { pausedByFocus = true; setPaused(true) } }
            else if (change == AudioManager.AUDIOFOCUS_GAIN && pausedByFocus) { DiagnosticsLog.app.record("info","Audio focus regained, resuming"); pausedByFocus = false; setPaused(false) }
        },main).build()
    init {
        val config = File(context.filesDir,"mpv").apply { mkdirs() }
        val certificate = File(config,"cacert.pem")
        context.assets.open("cacert.pem").use { input -> certificate.outputStream().use { input.copyTo(it) } }
        MPVLib.create(context.applicationContext)
        // Emby supplies direct media URLs. Never spawn absent desktop extractors
        // after a network error (the bundled Android subprocess path is unsafe).
        val options = mapOf("config" to "no","ytdl" to "no","profile" to "fast","vo" to "gpu","gpu-context" to "android","opengl-es" to "yes","hwdec" to "mediacodec,mediacodec-copy","ao" to "audiotrack,opensles","idle" to "yes","keep-open" to "yes","force-window" to "no","osc" to "no","input-default-bindings" to "no","tls-verify" to "yes","tls-ca-file" to certificate.path,"save-position-on-quit" to "no","gpu-shader-cache-dir" to context.cacheDir.path,"sub-fonts-dir" to "/system/fonts")
        for ((name,value) in options) require(MPVLib.setOptionString(name,value) >= 0) { "mpv 初始化选项失败：$name" }
        MPVLib.init(); MPVLib.addObserver(this); MPVLib.addLogObserver(this)
        for (property in listOf("time-pos","duration","speed","volume","cache-buffering-state","video-params/aspect")) MPVLib.observeProperty(property,MPVLib.MpvFormat.MPV_FORMAT_DOUBLE)
        for (property in listOf("pause","paused-for-cache","eof-reached")) MPVLib.observeProperty(property,MPVLib.MpvFormat.MPV_FORMAT_FLAG)
        MPVLib.observeProperty("track-list",MPVLib.MpvFormat.MPV_FORMAT_NONE)
        for (property in listOf("sub-text","current-tracks/sub/codec")) MPVLib.observeProperty(property,MPVLib.MpvFormat.MPV_FORMAT_STRING)
        applySettings()
        context.registerReceiver(noisyReceiver,IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),Context.RECEIVER_NOT_EXPORTED)
        mediaSession.setCallback(object: MediaSession.Callback() {
            // Headsets, the notification, a car or a watch send these.
            override fun onPlay() { DiagnosticsLog.app.record("info","Media session play"); dispatch("play",JSONArray()) }
            override fun onPause() { DiagnosticsLog.app.record("info","Media session pause"); dispatch("pause",JSONArray()) }
            override fun onStop() { dispatch("stop",JSONArray(),"media session") }
            override fun onSeekTo(pos: Long) { dispatch("seekTo",JSONArray().put(pos)) }
        },main)
    }
    // The video output opens on the surface first; then a video load held for it starts.
    @Synchronized fun attach(surface: Surface) { if (!destroyed) { DiagnosticsLog.app.record("info","Video surface attached"); MPVLib.attachSurface(surface); MPVLib.setPropertyString("vo",videoOutput()); MPVLib.setPropertyString("force-window","yes"); surfaceGate.attached() } }
    @Synchronized fun detach() { surfaceGate.detached(); main.removeCallbacks(resizeOutput); if (!destroyed) { DiagnosticsLog.app.record("info","Video surface detached"); MPVLib.setPropertyString("vo","null"); MPVLib.setPropertyString("force-window","no"); MPVLib.detachSurface() } }
    fun surfaceSize(width: Int,height: Int) {
        if(destroyed || width<=0 || height<=0) return
        val next = "${width}x$height"; if(next == surfaceDimensions) return
        surfaceDimensions = next; MPVLib.setPropertyString("android-surface-size",next)
        main.removeCallbacks(resizeOutput); main.postDelayed(resizeOutput,180)
    }
    fun positionSeconds(): Double = if (destroyed) 0.0 else MPVLib.getPropertyDouble("time-pos") ?: state.positionMs / 1000.0
    /** Paused by the viewer or the system; a video waiting for its subtitle is paused as it will start. */
    fun isPaused(): Boolean = destroyed || hold?.let { !it.play } ?: (MPVLib.getPropertyBoolean("pause") != false)
    /** Every pause and resume: during a subtitle hold it only sets how the video starts. */
    private fun setPaused(paused: Boolean) {
        val held = hold
        if(held == null) { MPVLib.setPropertyBoolean("pause",paused); return }
        held.play = !paused
        state.update(held.generation,state.positionMs/1000.0,paused,state.speed); updateMediaSession()
    }
    @Synchronized fun beginTemporarySpeed(): Double? {
        if (destroyed || !state.active || state.loading || isPaused()) return null
        val rate = temporarySpeed.begin(MPVLib.getPropertyDouble("speed") ?: state.speed) ?: return null
        MPVLib.setPropertyDouble("speed",rate)
        return rate
    }
    @Synchronized fun endTemporarySpeed() {
        val rate = temporarySpeed.end() ?: return
        if (!destroyed) MPVLib.setPropertyDouble("speed",rate)
    }
    fun pauseForTutorial() { pausedByFocus=false;setPaused(true) }
    fun danmakuPosition(nanos: Long): Double = danmakuClock.position(positionSeconds(),nanos,
        !destroyed && state.active && MPVLib.getPropertyBoolean("core-idle") == false,
        state.speed,clockEpoch)
    fun tracks(): JSONArray = runCatching { JSONArray(MPVLib.getPropertyString("track-list") ?: "[]") }.getOrDefault(JSONArray())
    fun isVideo() = video
    fun currentItem(): JSONObject = metadata.optJSONObject("metadata") ?: JSONObject()
    private fun emit(name: String,vararg args: Any?) {
        val generation = state.generation
        val array = JSONArray(); args.forEach { array.put(it ?: JSONObject.NULL) }
        // A following load can begin before this queued notification is delivered.
        // An old cancellation must never end the replacement episode in Emby.
        main.post { if(!destroyed && generation == state.generation) signal(name,array) }
    }
    private fun setTrack(type: String, value: Any) {
        if (type == "sid") selectSubtitle(value)
        else MPVLib.setPropertyString(type,PlaybackContract.track(value.toString()))
    }
    private fun selectSubtitle(value: Any) {
        val url = PlaybackContract.externalSubtitle(value)
        if (url == null) { externalSubtitles.supersede(); MPVLib.setPropertyString("sid",PlaybackContract.track(value.toString())); return }
        // A file this item already has is selected at once.
        PlaybackContract.externalSubtitleTrack(tracks(),url)?.let { track -> externalSubtitles.supersede(); MPVLib.setPropertyString("sid",track.toString()); return }
        fetchSubtitle(externalSubtitles.request(state.generation,url) ?: return)
    }
    // Emby can take a minute to extract a subtitle from a large file. mpv fetches it on
    // this thread, the UI keeps running, and the reply selects the track. sub-add ends
    // with its item, so a stop or the next item aborts the fetch.
    private fun fetchSubtitle(request: ExternalSubtitles.Request) {
        DiagnosticsLog.app.record("info","External subtitle requested")
        thread(isDaemon = true,name = "mpv subtitle") {
            fetchLock.withLock { if (destroyed) return@thread; fetching++ }
            try { MPVLib.command(arrayOf("sub-add",request.url,"auto")) }
            finally { fetchLock.withLock { fetching--; fetchDone.signalAll() } }
            main.post { subtitleFetched(request) }
        }
    }
    private fun subtitleFetched(request: ExternalSubtitles.Request) {
        if (destroyed || !externalSubtitles.complete(request) || !state.active || request.generation != state.generation) return
        val track = PlaybackContract.externalSubtitleTrack(tracks(),request.url)
        MPVLib.setPropertyString("sid",track?.toString() ?: "no")
        DiagnosticsLog.app.record(if (track == null) "warning" else "info","External subtitle ${if (track == null) "failed" else "loaded"}${if (request.late) " after playback started" else ""}")
        // The viewer was told it would follow; say how that ended.
        if (request.late) notice(if (track == null) "字幕加载失败，可以在菜单里重新选择" else "字幕已加载",4000)
        if (hold?.generation == request.generation) releaseHold()
    }
    // The desktop starts a file whose subtitle is still on its way after 10 s, too.
    private fun startWithoutSubtitle() {
        val held = hold ?: return
        if (destroyed || !state.active || held.generation != state.generation) return
        if (externalSubtitles.startedWithout(held.generation)) {
            DiagnosticsLog.app.record("info","External subtitle still loading after 10 s; starting playback without it")
            notice("服务器还在准备字幕，先开始播放，准备好后自动加载",6000)
        }
        releaseHold()
    }
    private fun releaseHold() {
        val held = hold ?: return
        hold = null; main.removeCallbacks(holdTimeout)
        if (destroyed || !state.active || held.generation != state.generation) return
        state.hold(held.generation,false)
        MPVLib.setPropertyBoolean("pause",!held.play)
        // Before its file is loaded, the item starts as any other (FILE_LOADED).
        if (loadedGeneration == held.generation) { announceStart(held.generation); emit("positionUpdate",state.positionMs) }
    }
    // The state an item starts in, for the page.
    private fun announceStart(generation: Long) {
        val paused = MPVLib.getPropertyBoolean("pause") == true
        state.update(generation,positionSeconds(),paused,MPVLib.getPropertyDouble("speed") ?: 1.0)
        emit(if (paused) "paused" else "playing"); emit("videoPlaybackActive",!paused)
    }
    /** What belongs to one item: its pending subtitle and hold, its intro marker. */
    private fun resetItem() {
        externalSubtitles.supersede(); hold = null; main.removeCallbacks(holdTimeout)
        introSkip.clear(); main.removeCallbacks(introSeekTimeout); main.post { introSkipChanged(false) }
    }
    private fun setSeeking(value: Boolean) {
        // Queued events, in order with the position reports between them (as on the desktop).
        if (seeking == value) return
        seeking = value; emit("seekingChanged",value)
    }
    /** The "跳过片头" button is offered for the playing video. */
    fun introSkipOffered() = !destroyed && state.active && video && introSkip.button
    /** The button: jump past the intro. */
    fun skipIntro() {
        if (destroyed || !state.active) return
        introSkip.skip()?.let { end -> DiagnosticsLog.app.record("info","Intro skipped (button)"); jumpPastIntro(end) }
        introSkipChanged(introSkipOffered())
    }
    private fun jumpPastIntro(end: Double) {
        main.removeCallbacks(introSeekTimeout); main.postDelayed(introSeekTimeout,IntroSkip.SEEK_TIMEOUT_MS)
        clockEpoch++; MPVLib.command(arrayOf("seek",end.toString(),"absolute+exact"))
    }
    // Runs one of IntroSkip's decisions; a target is an automatic skip.
    private fun introDecision(decide: () -> Double?) {
        val shown = introSkip.button
        decide()?.let { end -> DiagnosticsLog.app.record("info","Intro skipped (automatic)"); jumpPastIntro(end); notice("已跳过片头",2000) }
        if (introSkip.button != shown) introSkipChanged(introSkip.button)
    }
    private fun loadedPosition(): Double? = if (state.active && loadedGeneration == state.generation) MPVLib.getPropertyDouble("time-pos") else null
    // Time from mpv, else the last observed position; the duration mpv reported.
    private fun recordEnd(level: String, cause: String, endOfFile: Boolean = false) =
        DiagnosticsLog.app.record(level,PlaybackContract.endRecord(cause,positionSeconds(),if(durationMs > 0) durationMs/1000.0 else null,endOfFile))
    /** [source] names who asked, for the diagnostics of a stop: the web page unless a native control. */
    @Synchronized fun dispatch(method: String,args: JSONArray,source: String = "web"): Any? {
        check(!destroyed) { "播放器已关闭" }
        when (method) {
            "queueMedia" -> throw IllegalArgumentException("请通过服务器网页的播放队列添加媒体")
            "load" -> {
                val url = args.getString(0); require(url.startsWith("http://") || url.startsWith("https://") || url.startsWith("content://")) { "不支持的媒体地址" }
                if(state.active) recordEnd("info","replaced by a new load")
                val options = args.optJSONObject(1) ?: JSONObject(); metadata = args.optJSONObject(2) ?: JSONObject()
                video = PlaybackContract.isVideo(metadata.optString("type","video"))
                val hdr = video && metadata.optString("dynamicRange") == "hdr" && settings.string("video","hardwareDecoding") != "disabled" && displayHdr()
                if (hdr != hdrOutput) setOutput(hdr)
                rangeReported = false
                main.post { subtitleText("") }
                DiagnosticsLog.app.record("info","Player output ${videoOutput()}")
                DiagnosticsLog.app.record("info","Player load requested video=$video")
                audio = args.opt(3) ?: 1; subtitle = args.opt(4) ?: -1; startMs = options.optDouble("startMilliseconds",0.0)
                endTemporarySpeed(); resetItem()
                val generation = state.begin(url); durationMs = 0; clockEpoch++
                currentId = EpisodeQueue.currentIdFor(queued,metadata.optJSONObject("metadata") ?: JSONObject())
                val headers = metadata.optJSONObject("headers") ?: JSONObject()
                val fields = headers.keys().asSequence().map { key -> require(key == "User-Agent" || key == "Referer") { "不支持的媒体请求头" }; val value = headers.getString(key); require(!value.contains('\n') && !value.contains('\r')); "$key: $value" }.toList()
                MPVLib.setPropertyString("http-header-fields",fields.joinToString(","))
                // A video that starts with an external subtitle waits for it (FILE_LOADED), paused meanwhile.
                val autoplay = options.optBoolean("autoplay",true)
                if(video && PlaybackContract.externalSubtitle(subtitle) != null) hold = Hold(generation,autoplay)
                MPVLib.setPropertyBoolean("pause",hold != null || !autoplay); MPVLib.setPropertyDouble("speed",settings.number("video","default_playback_speed"))
                audioManager.requestAudioFocus(focus); mediaSession.isActive = true
                main.post { if(!destroyed && state.active && generation == state.generation) { visible(video); itemChanged(metadata.optJSONObject("metadata") ?: JSONObject()) } }
                emit("windowVisible",video); emit("onMetaData",metadata,url)
                // A video waits until the view shown above has its surface. The file it
                // replaces must not keep playing meanwhile.
                if(!surfaceGate.load(generation,url,video)) MPVLib.command(arrayOf("stop"))
                return true
            }
            "stop" -> { if(state.active) recordEnd("info","stop requested by $source"); endTemporarySpeed(); resetItem(); surfaceGate.cancel(); val generation = state.generation; val active = state.end(generation); MPVLib.command(arrayOf("stop")); audioManager.abandonAudioFocusRequest(focus); mediaSession.isActive = false; main.post { if(!state.active && generation == state.generation) visible(false) }; emit("windowVisible",false); if(active){emit("canceled");emit("stopped")}; return true }
            "pause" -> { endTemporarySpeed();pauseIntent++;pausedByFocus=false;setPaused(true) }
            "play" -> setPaused(false)
            // [text] or [text, ms]: watch-together notices last 1.5–16 s. Drawn natively, so HDR output shows them too.
            "showMessage" -> { val text = args.getString(0).take(200); val ms = PlaybackContract.noticeMillis(args.opt(1)); main.post { if(!destroyed) notice(text,ms) } }
            "seekTo" -> { clockEpoch++; MPVLib.command(arrayOf("seek",(args.getDouble(0)/1000.0).coerceAtLeast(0.0).toString(),"absolute+exact")) }
            "setPlaybackRate" -> { val rate = args.getDouble(0)/1000.0; require(rate in 0.25..4.0); endTemporarySpeed(); MPVLib.setPropertyDouble("speed",rate) }
            "setVolume" -> MPVLib.setPropertyDouble("volume",args.getDouble(0).coerceIn(0.0,100.0))
            "setMuted" -> MPVLib.setPropertyBoolean("mute",args.getBoolean(0))
            "volume" -> return (MPVLib.getPropertyDouble("volume") ?: 100.0).toInt()
            "muted" -> return MPVLib.getPropertyBoolean("mute") ?: false
            "getPosition" -> return (positionSeconds()*1000).toLong()
            "getDuration" -> return durationMs
            "getSubtitleStreams" -> return metadata.optJSONObject("media")?.optJSONArray("subtitleStreams") ?: JSONArray()
            "setAudioStream" -> setTrack("aid",args.get(0))
            "setSubtitleStream" -> {
                // Before its file is loaded, the item's selection is applied at FILE_LOADED.
                subtitle = args.get(0)
                val loaded = state.active && loadedGeneration == state.generation
                if(loaded) selectSubtitle(subtitle)
                // A video waiting for a subtitle the viewer no longer wants starts now.
                val held = hold
                if(held != null && (if(loaded) !externalSubtitles.pending(held.generation) else PlaybackContract.externalSubtitle(subtitle) == null)) releaseHold()
            }
            "setIntroSkip" -> {
                // An invalid marker clears the previous one, as on the desktop; it never fails the page.
                val intro = IntroSkip.parse(args.opt(0))
                DiagnosticsLog.app.record("info",if(intro == null) "Intro marker cleared" else "Intro marker set (${if(intro.auto) "automatic skip" else "button"})")
                main.removeCallbacks(introSeekTimeout)
                introDecision { introSkip.set(intro,loadedPosition()) }
            }
            "setAudioDelay" -> MPVLib.setPropertyDouble("audio-delay",args.getDouble(0)/1000.0)
            "setSubtitleDelay" -> MPVLib.setPropertyDouble("sub-delay",args.getDouble(0)/1000.0)
            "getAudioDeviceList" -> return JSONArray().put(JSONObject().put("name","auto").put("description","安卓系统输出"))
            "setAudioDevice" -> { require(args.getString(0) == "auto"); MPVLib.setPropertyString("audio-device","auto") }
            "clearQueue" -> MPVLib.command(arrayOf("playlist-clear"))
            "streamSwitch" -> { /* The following load replaces the stream and retains its requested position. */ }
            "setVideoRectangle" -> if(args.optInt(0) >= 0 && args.optInt(2) > 0) emit("onVideoRecangleChanged")
            "setVideoOnlyMode" -> {
                // The page closes the video view; mpv itself keeps playing.
                if(!args.getBoolean(0) && state.active && video) DiagnosticsLog.app.record("info","Web hid the video view during playback")
                if(!args.getBoolean(0)) endTemporarySpeed(); main.post { visible(args.getBoolean(0) && state.active && video) } }
            "getWebPlaylist" -> return queued
            "getCurrentWebPlaylistItemId" -> return currentId
            "setWebPlaylist" -> { queued = args.getJSONArray(0); currentId = args.optString(1); emit("webPlaylistChanged",queued,currentId) }
            "mpvDiagnostics" -> return JSONObject().put("version",MPVLib.getPropertyString("mpv-version")).put("renderBackend","Android Surface / OpenGL ES").put("configMode","embedded").put("configuredProfile","fast / Android MediaCodec").put("currentVo",MPVLib.getPropertyString("vo")).put("hwdec",MPVLib.getPropertyString("hwdec-current")).put("audioTrack",MPVLib.getPropertyInt("aid") ?: -1).put("subtitleTrack",MPVLib.getPropertyInt("sid") ?: -1).put("subtitleDelay",MPVLib.getPropertyDouble("sub-delay") ?: 0.0).put("tracks",tracks()).put("sourceWidth",MPVLib.getPropertyInt("video-params/w") ?: 0).put("sourceHeight",MPVLib.getPropertyInt("video-params/h") ?: 0)
                .put("surfaceSize",MPVLib.getPropertyString("android-surface-size")).put("osdDimensions",MPVLib.getPropertyString("osd-dimensions"))
                .put("subtitleBold",MPVLib.getPropertyString("sub-bold")).put("subtitlePosition",MPVLib.getPropertyString("sub-pos")).put("subtitleAlignY",MPVLib.getPropertyString("sub-align-y"))
                .put("subtitleHeld",state.held).put("seeking",seeking)
                .put("introSkip",introSkip.intro?.let { JSONObject().put("start",it.start).put("end",it.end).put("auto",it.auto) } ?: JSONObject.NULL).put("introSkipOffered",introSkip.offered)
            "notifyMetadata" -> { val item = args.optJSONObject(0) ?: JSONObject(); mediaSession.setMetadata(MediaMetadata.Builder().putString(MediaMetadata.METADATA_KEY_TITLE,item.optString("Name",item.optString("title"))).build()) }
            "notifyStreamingBitrateResult" -> main.post { message(if(args.optBoolean(1)) "画质已切换" else args.optString(2,"品质切换失败")) }
            else -> {
                require(method in setOf("notifyShuffleChange","notifyRepeatChange","notifyFullscreenChange","notifyRateChange","notifyQueueChange","notifyPlaybackStop","notifyDurationChange","notifyPlaybackState","notifyPosition","notifySeek","notifyVolumeChange")) { "未支持的播放操作" }
                updateMediaSession()
            }
        }
        return true
    }
    fun applySettings() {
        MPVLib.setPropertyString("hwdec",hardwareDecoding())
        MPVLib.setPropertyString("demuxer-max-bytes",(settings.number("video","cache")*1024*1024).toLong().toString())
        MPVLib.setPropertyBoolean("deinterlace",settings.bool("video","deinterlace"))
        MPVLib.setPropertyString("video-sync",settings.string("video","sync_mode"))
        MPVLib.setPropertyDouble("audio-delay",settings.number("video","audio_delay.normal")/1000.0)
        MPVLib.setPropertyString("alang",settings.string("mpv","audioLanguage")); MPVLib.setPropertyString("slang",settings.string("mpv","subtitleLanguage"))
        MPVLib.setPropertyBoolean("cache-pause",settings.bool("mpv","cachePause")); MPVLib.setPropertyBoolean("deband",settings.bool("mpv","deband"))
        MPVLib.setPropertyString("tone-mapping",settings.string("mpv","toneMapping"))
        MPVLib.setPropertyString("audio-channels",settings.string("audio","channels"))
        MPVLib.setPropertyString("af",if(settings.bool("audio","normalize")) "lavfi=[dynaudnorm]" else "")
        MPVLib.setPropertyString("sub-ass-style-overrides",if(settings.bool("subtitles","ass_scale_border_and_shadow")) "ScaledBorderAndShadow=yes" else "ScaledBorderAndShadow=no")
        val mapping = mapOf("ass_style_override" to "sub-ass-override","color" to "sub-color","border_color" to "sub-border-color","border_size" to "sub-border-size","size" to "sub-font-size","font" to "sub-font")
        val defaults = mapOf("ass_style_override" to "yes","color" to "#FFFFFF","border_color" to "#000000","border_size" to "3","size" to "55")
        for((key,property) in mapping) { var value = settings.string("subtitles",key); if(value.isEmpty() || value == "-1") value = defaults[key] ?: ""; if(value.isNotEmpty()) MPVLib.setPropertyString(property,if(value == "true") "yes" else if(value == "false") "no" else value) }
        MPVLib.setPropertyString("sub-bold",if(settings.bool("subtitles","bold")) "yes" else "no")
        val placement = settings.string("subtitles","placement").split(',')
        MPVLib.setPropertyString("sub-align-x",placement.getOrNull(0)?.ifEmpty { "center" } ?: "center")
        val vertical = PlaybackContract.subtitleVertical(placement.getOrNull(1),settings.number("subtitles","vertical_position"))
        MPVLib.setPropertyString("sub-align-y",vertical.align); MPVLib.setPropertyString("sub-pos",vertical.position.toString())
        val back = settings.string("subtitles","background_color").ifBlank { "#000000" }
        val alpha = settings.string("subtitles","background_transparency").ifBlank { "00" }
        MPVLib.setPropertyString("sub-back-color",PlaybackContract.subtitleBackground(back,alpha))
        val aspect = settings.string("video","aspect")
        MPVLib.setPropertyString("video-aspect-override",when(aspect){"force_4_3"->"4:3";"force_16_9"->"16:9";"force_16_9_if_4_3"->if(kotlin.math.abs((MPVLib.getPropertyDouble("video-params/aspect") ?: 0.0)-4.0/3)<.02) "16:9" else "-1";else->"-1"})
        MPVLib.setPropertyBoolean("keepaspect",aspect != "stretch")
        MPVLib.setPropertyString("video-unscaled",if(aspect == "noscaling") "yes" else "no")
        MPVLib.setPropertyDouble("panscan",if(aspect == "zoom") 1.0 else 0.0)
    }
    private fun updateMediaSession() {
        val status = if(!state.active) android.media.session.PlaybackState.STATE_STOPPED else if(state.paused) android.media.session.PlaybackState.STATE_PAUSED else android.media.session.PlaybackState.STATE_PLAYING
        mediaSession.setPlaybackState(android.media.session.PlaybackState.Builder().setActions(android.media.session.PlaybackState.ACTION_PLAY_PAUSE or android.media.session.PlaybackState.ACTION_SEEK_TO or android.media.session.PlaybackState.ACTION_STOP).setState(status,state.positionMs,state.speed.toFloat()).build())
    }
    private fun finish(generation: Long, cause: String) {
        if(!state.end(generation)) return
        // mpv's position is still the last frame's until the stop below.
        recordEnd("info",cause,endOfFile = true)
        endTemporarySpeed(); resetItem()
        MPVLib.command(arrayOf("stop")); pausedByFocus = false; audioManager.abandonAudioFocusRequest(focus); mediaSession.isActive = false
        visible(false); emit("windowVisible",false); emit("finished"); emit("stopped"); updateMediaSession()
    }
    override fun logMessage(prefix: String, level: Int, text: String) {
        if(level in MPVLib.MpvLogLevel.MPV_LOG_LEVEL_FATAL..MPVLib.MpvLogLevel.MPV_LOG_LEVEL_WARN)
            DiagnosticsLog.app.record(if(level <= MPVLib.MpvLogLevel.MPV_LOG_LEVEL_ERROR) "error" else "warning","mpv $prefix: $text")
    }
    override fun event(eventId: Int) {
        if(eventId == MPVLib.MpvEvent.MPV_EVENT_FILE_LOADED) DiagnosticsLog.app.record("info","Player file loaded")
        if(eventId == MPVLib.MpvEvent.MPV_EVENT_START_FILE) eventGeneration = starts.poll() ?: state.generation
        val generation = eventGeneration
        main.post {
        if(destroyed) return@post
        when(eventId) {
            MPVLib.MpvEvent.MPV_EVENT_START_FILE -> setSeeking(false)
            MPVLib.MpvEvent.MPV_EVENT_SEEK -> if(generation == state.generation && state.active) setSeeking(true)
            MPVLib.MpvEvent.MPV_EVENT_PLAYBACK_RESTART -> {
                state.ready(generation); setSeeking(false)
                if(generation == state.generation && state.active) { main.removeCallbacks(introSeekTimeout); introDecision { introSkip.restarted(loadedPosition()) } }
            }
            MPVLib.MpvEvent.MPV_EVENT_FILE_LOADED -> if(generation == state.generation && state.active) {
                loadedGeneration = generation
                if(startMs > 0) MPVLib.command(arrayOf("seek",(startMs/1000).toString(),"absolute+exact")); setTrack("aid",audio); setTrack("sid",subtitle)
                val held = hold
                if(held != null && held.generation == generation && externalSubtitles.pending(generation)) {
                    // As the desktop's on_preloaded hold: the page hears of the start when it ends.
                    DiagnosticsLog.app.record("info","Player waits up to 10 s for its external subtitle")
                    state.hold(generation,true); state.update(generation,positionSeconds(),!held.play,MPVLib.getPropertyDouble("speed") ?: 1.0)
                    main.removeCallbacks(holdTimeout); main.postDelayed(holdTimeout,HOLD_MS)
                } else if(held != null) releaseHold() else announceStart(generation)
            }
            MPVLib.MpvEvent.MPV_EVENT_END_FILE -> { setSeeking(false); if(generation == state.generation && state.active) {
                val eof = MPVLib.getPropertyBoolean("eof-reached") == true
                if(eof) finish(generation,"end of file (end-file event)") else { recordEnd("error","end-file without EOF; media load or network failure"); endTemporarySpeed(); resetItem(); state.end(generation); visible(false); audioManager.abandonAudioFocusRequest(focus); mediaSession.isActive = false; emit("windowVisible",false); emit("error","mpv 无法播放此媒体，请检查地址、格式和网络"); emit("stopped"); updateMediaSession() }
            } }
        }
    } }
    override fun eventProperty(property: String, value: Double) { val generation = eventGeneration; main.post {
        if(destroyed || !state.active || generation != state.generation) return@post
        when(property) {
            "time-pos" -> {
                state.update(state.generation,value,isPaused(),MPVLib.getPropertyDouble("speed") ?: 1.0)
                // A video waiting for its subtitle has not started for the page (see releaseHold).
                if(hold == null) emit("positionUpdate",state.positionMs)
                updateMediaSession(); if(video && !rangeReported) reportDynamicRange()
                if(loadedGeneration == generation) introDecision { introSkip.decide(value) }
            }
            "duration" -> { durationMs = (value*1000).toLong(); emit("updateDuration",durationMs) }
            "cache-buffering-state" -> emit("buffering",value.toInt())
            "speed" -> { state.update(state.generation,positionSeconds(),isPaused(),value); emit("playbackRateChanged",value) }
            "video-params/aspect" -> { videoAspect = value; videoLayout(value,hdrOutput) }
        }
    } }
    override fun eventProperty(property: String, value: Boolean) { val generation = eventGeneration; main.post {
        if(destroyed || !state.active || generation != state.generation) return@post
        if(property == "eof-reached" && value) { finish(generation,"end of file (eof-reached)"); return@post }
        // The hold's own pause is not the viewer's.
        if(property == "pause" && hold?.generation != generation) { state.update(state.generation,positionSeconds(),value,state.speed); emit(if(value) "paused" else "playing"); emit("videoPlaybackActive",!value); updateMediaSession() }
        if(property == "paused-for-cache") { state.buffering(generation,value); emit("buffering",if(value) 0 else 100) }
    } }
    override fun eventProperty(property: String, value: Long) {}
    override fun eventProperty(property: String, value: String) { val generation = eventGeneration; main.post {
        if(destroyed || !state.active || generation != state.generation) return@post
        when(property) {
            "sub-text" -> subtitleText(if(hdrOutput) value else "")
            "current-tracks/sub/codec" -> if(hdrOutput && PlaybackContract.isImageSubtitle(value)) {
                // Picture subtitles exist only as mpv overlays: show them, tone mapped.
                setOutput(false); subtitleText("")
                message("图形字幕需要关闭 HDR 直出，已改为色调映射")
            }
        }
    } }
    override fun eventProperty(property: String) {
        if(property == "track-list") emit("onVideoRecangleChanged")
        if(property == "sub-text") main.post { subtitleText("") }
    }
    private fun colorParams(prefix: String) = PlaybackContract.ColorParams(MPVLib.getPropertyInt("$prefix/w") ?: 0,MPVLib.getPropertyInt("$prefix/h") ?: 0,
        MPVLib.getPropertyString("$prefix/primaries").orEmpty(),MPVLib.getPropertyString("$prefix/gamma").orEmpty(),MPVLib.getPropertyDouble("$prefix/max-luma") ?: 0.0)
    private fun reportDynamicRange() {
        val source = colorParams("video-params")
        // MediaCodec hands the frames to the compositor in their own colorspace; mpv has no target.
        val target = if(hdrOutput) source else colorParams("video-target-params")
        val text = PlaybackContract.dynamicRangeText(source,target,MPVLib.getPropertyInt("current-tracks/video/dolby-vision-profile") ?: 0,
            MPVLib.getPropertyString("tone-mapping").orEmpty()) ?: return
        rangeReported = true
        DiagnosticsLog.app.record("info","Dynamic range: " + text.replace("\n"," | "))
        dynamicRange(text)
    }
    @Synchronized private fun setOutput(hdr: Boolean) {
        if(destroyed) return
        hdrOutput = hdr; rangeReported = false
        MPVLib.setPropertyString("hwdec",hardwareDecoding())
        if (surfaceGate.hasSurface) MPVLib.setPropertyString("vo",videoOutput())
        main.post { videoLayout(videoAspect,hdr) }
    }
    // Watch-together reads this before the pause so it reports away instead of pausing the room.
    fun background() { endTemporarySpeed(); if(state.active && !state.paused) { emit("backgrounded"); dispatch("pause",JSONArray()) } }
    fun destroy() {
        if(destroyed) return
        endTemporarySpeed(); resetItem(); surfaceGate.cancel(); state.end(state.generation)
        // A subtitle fetch blocks its thread inside mpv: end it (sub-add ends with the item) before mpv goes away.
        val fetches = fetchLock.withLock { destroyed = true; fetching }
        if(fetches > 0) {
            MPVLib.command(arrayOf("stop"))
            fetchLock.withLock { var left = TimeUnit.SECONDS.toNanos(2); while(fetching > 0 && left > 0) left = fetchDone.awaitNanos(left) }
        }
        main.removeCallbacks(resizeOutput); main.removeCallbacks(holdTimeout); main.removeCallbacks(introSeekTimeout)
        context.unregisterReceiver(noisyReceiver); MPVLib.removeObserver(this); MPVLib.removeLogObserver(this); MPVLib.destroy(); mediaSession.release(); audioManager.abandonAudioFocusRequest(focus)
    }
    private companion object { const val HOLD_MS = 10000L }
}
