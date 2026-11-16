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

class PlaybackController(private val context: Context, private val settings: SettingsStore) : MPVLib.EventObserver, MPVLib.LogObserver {
    val state = PlaybackState()
    private val temporarySpeed = TemporaryPlaybackSpeed()
    val temporarySpeedActive get() = temporarySpeed.active
    private val main = Handler(Looper.getMainLooper())
    private val starts = ConcurrentLinkedQueue<Long>()
    @Volatile private var eventGeneration = 0L
    private var destroyed = false
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
    var signal: (String, JSONArray) -> Unit = { _, _ -> }
    var visible: (Boolean) -> Unit = {}
    var itemChanged: (JSONObject) -> Unit = {}
    var message: (String) -> Unit = {}
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
                MPVLib.setPropertyBoolean("pause",true)
            }
        }
    }
    private val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
        .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MOVIE).build())
        .setOnAudioFocusChangeListener({ change ->
            if (change < 0 && state.active) { DiagnosticsLog.app.record("info","Audio focus lost ($change), pausing"); endTemporarySpeed(); pauseIntent++; if(!isPaused()) { pausedByFocus = true; MPVLib.setPropertyBoolean("pause",true) } }
            else if (change == AudioManager.AUDIOFOCUS_GAIN && pausedByFocus) { DiagnosticsLog.app.record("info","Audio focus regained, resuming"); pausedByFocus = false; MPVLib.setPropertyBoolean("pause",false) }
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
    fun isPaused(): Boolean = destroyed || MPVLib.getPropertyBoolean("pause") != false
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
    fun pauseForTutorial() { pausedByFocus=false;MPVLib.setPropertyBoolean("pause",true) }
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
        if (type == "sid" && value.toString().startsWith("#,")) MPVLib.command(arrayOf("sub-add",value.toString().removePrefix("#,"),"select"))
        else MPVLib.setPropertyString(type,PlaybackContract.track(value.toString()))
    }
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
                endTemporarySpeed()
                val generation = state.begin(url); durationMs = 0; clockEpoch++
                currentId = EpisodeQueue.currentIdFor(queued,metadata.optJSONObject("metadata") ?: JSONObject())
                val headers = metadata.optJSONObject("headers") ?: JSONObject()
                val fields = headers.keys().asSequence().map { key -> require(key == "User-Agent" || key == "Referer") { "不支持的媒体请求头" }; val value = headers.getString(key); require(!value.contains('\n') && !value.contains('\r')); "$key: $value" }.toList()
                MPVLib.setPropertyString("http-header-fields",fields.joinToString(","))
                MPVLib.setPropertyBoolean("pause",!options.optBoolean("autoplay",true)); MPVLib.setPropertyDouble("speed",settings.number("video","default_playback_speed"))
                audioManager.requestAudioFocus(focus); mediaSession.isActive = true
                main.post { if(!destroyed && state.active && generation == state.generation) { visible(video); itemChanged(metadata.optJSONObject("metadata") ?: JSONObject()) } }
                emit("windowVisible",video); emit("onMetaData",metadata,url)
                // A video waits until the view shown above has its surface. The file it
                // replaces must not keep playing meanwhile.
                if(!surfaceGate.load(generation,url,video)) MPVLib.command(arrayOf("stop"))
                return true
            }
            "stop" -> { if(state.active) recordEnd("info","stop requested by $source"); endTemporarySpeed(); surfaceGate.cancel(); val generation = state.generation; val active = state.end(generation); MPVLib.command(arrayOf("stop")); audioManager.abandonAudioFocusRequest(focus); mediaSession.isActive = false; main.post { if(!state.active && generation == state.generation) visible(false) }; emit("windowVisible",false); if(active){emit("canceled");emit("stopped")}; return true }
            "pause" -> { endTemporarySpeed();pauseIntent++;pausedByFocus=false;MPVLib.setPropertyBoolean("pause",true) }
            "play" -> MPVLib.setPropertyBoolean("pause",false)
            "showMessage" -> MPVLib.command(arrayOf("show-text",args.getString(0).take(200),"3000"))
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
            "setSubtitleStream" -> setTrack("sid",args.get(0))
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
        val placement = settings.string("subtitles","placement").split(',')
        MPVLib.setPropertyString("sub-align-x",placement.getOrNull(0)?.ifEmpty { "center" } ?: "center")
        MPVLib.setPropertyString("sub-align-y",placement.getOrNull(1) ?: "bottom")
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
        endTemporarySpeed()
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
            MPVLib.MpvEvent.MPV_EVENT_PLAYBACK_RESTART -> state.ready(generation)
            MPVLib.MpvEvent.MPV_EVENT_FILE_LOADED -> if(generation == state.generation && state.active) { if(startMs > 0) MPVLib.command(arrayOf("seek",(startMs/1000).toString(),"absolute+exact")); setTrack("aid",audio); setTrack("sid",subtitle); val paused = MPVLib.getPropertyBoolean("pause") == true; state.update(generation,positionSeconds(),paused,MPVLib.getPropertyDouble("speed") ?: 1.0); emit(if(paused) "paused" else "playing"); emit("videoPlaybackActive",!paused) }
            MPVLib.MpvEvent.MPV_EVENT_END_FILE -> if(generation == state.generation && state.active) {
                val eof = MPVLib.getPropertyBoolean("eof-reached") == true
                if(eof) finish(generation,"end of file (end-file event)") else { recordEnd("error","end-file without EOF; media load or network failure"); endTemporarySpeed(); state.end(generation); visible(false); audioManager.abandonAudioFocusRequest(focus); mediaSession.isActive = false; emit("windowVisible",false); emit("error","mpv 无法播放此媒体，请检查地址、格式和网络"); emit("stopped"); updateMediaSession() }
            }
        }
    } }
    override fun eventProperty(property: String, value: Double) { val generation = eventGeneration; main.post {
        if(destroyed || !state.active || generation != state.generation) return@post
        when(property) {
            "time-pos" -> { state.update(state.generation,value,MPVLib.getPropertyBoolean("pause") == true,MPVLib.getPropertyDouble("speed") ?: 1.0); emit("positionUpdate",state.positionMs); updateMediaSession(); if(video && !rangeReported) reportDynamicRange() }
            "duration" -> { durationMs = (value*1000).toLong(); emit("updateDuration",durationMs) }
            "cache-buffering-state" -> emit("buffering",value.toInt())
            "speed" -> { state.update(state.generation,positionSeconds(),isPaused(),value); emit("playbackRateChanged",value) }
            "video-params/aspect" -> { videoAspect = value; videoLayout(value,hdrOutput) }
        }
    } }
    override fun eventProperty(property: String, value: Boolean) { val generation = eventGeneration; main.post {
        if(destroyed || !state.active || generation != state.generation) return@post
        if(property == "eof-reached" && value) { finish(generation,"end of file (eof-reached)"); return@post }
        if(property == "pause") { state.update(state.generation,positionSeconds(),value,state.speed); emit(if(value) "paused" else "playing"); emit("videoPlaybackActive",!value); updateMediaSession() }
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
    fun destroy() { if(destroyed) return; endTemporarySpeed(); surfaceGate.cancel(); state.end(state.generation); destroyed = true; main.removeCallbacks(resizeOutput); context.unregisterReceiver(noisyReceiver); MPVLib.removeObserver(this); MPVLib.removeLogObserver(this); MPVLib.destroy(); mediaSession.release(); audioManager.abandonAudioFocusRequest(focus) }
}
