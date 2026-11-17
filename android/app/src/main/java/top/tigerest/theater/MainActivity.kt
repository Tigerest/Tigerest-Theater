package top.tigerest.theater

import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.database.ContentObserver
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.hardware.display.DisplayManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.ValueCallback
import android.webkit.WebView
import android.widget.*
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.lifecycle.lifecycleScope
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import kotlin.concurrent.thread

class MainActivity: ComponentActivity(),DisplayManager.DisplayListener {
    private val model: ClientModel by viewModels()
    val danmaku get() = model.danmaku
    val updates get() = model.updates
    private var updateListener: ((JSONObject) -> Unit)? = null
    lateinit var webHost: WebHost; private set
    private lateinit var bridge: BridgeDispatcher
    private lateinit var root: FrameLayout
    private lateinit var video: FrameLayout
    private lateinit var overlay: DanmakuOverlay
    private lateinit var controls: VideoControls
    private lateinit var progress: ProgressBar
    private var webFileCallback: ValueCallback<Array<Uri>>? = null
    private var serverAddressDialog: android.app.AlertDialog? = null
    private var importToken = 0L
    private var hinge = JSONObject()
    private var currentInsets: WindowInsets? = null
    private var currentPane = Pane(0,0,0,0)
    private var safeContent = Pane(0,0,0,0)
    var fullscreen = false; private set
    private var beforePlaybackFullscreen: Boolean? = null
    var playbackTouchLocked: Boolean
        get() = model.playbackTouchLocked
        set(value) { model.playbackTouchLocked = value }
    private val rotationObserver = object: ContentObserver(android.os.Handler(android.os.Looper.getMainLooper())) {
        override fun onChange(selfChange: Boolean) { syncSystemRotation() }
    }
    private val webFile = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val uris = result.data?.let { data -> data.clipData?.let { clip -> Array(clip.itemCount) { clip.getItemAt(it).uri } } ?: data.data?.let { arrayOf(it) } }
        webFileCallback?.onReceiveValue(uris); webFileCallback = null
    }
    private val danmakuFile = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> if(uri != null) {
        val token = importToken
        thread {
        runCatching { contentResolver.openInputStream(uri)!!.use { input -> val bytes = input.readNBytes(16*1024*1024+1); require(bytes.size <= 16*1024*1024) { "弹幕文件过大" }; danmaku.importText(uri.toString(),"本地弹幕",bytes.toString(Charsets.UTF_8),token) } }.onFailure { runOnUiThread { notify(it.message ?: "弹幕文件无法读取") } }
    } } }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        syncSystemRotation()
        contentResolver.registerContentObserver(Settings.System.getUriFor(Settings.System.ACCELEROMETER_ROTATION),false,rotationObserver)
        window.setDecorFitsSystemWindows(false)
        window.attributes = window.attributes.apply { layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS }
        window.isNavigationBarContrastEnforced = false
        try {
            if(BuildConfig.DEBUG && intent.hasExtra("updateFixture")) updates.debugFixture(intent.getStringExtra("updateFixture")!!)
            root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }; setContentView(root)
            val web = WebView(this); root.addView(web,FrameLayout.LayoutParams(-1,-1))
            video = FrameLayout(this).apply { setBackgroundColor(Color.BLACK); visibility = View.GONE }
            val surface = MpvSurface(this,model.player); video.addView(surface,FrameLayout.LayoutParams(-1,-1,Gravity.CENTER))
            overlay = DanmakuOverlay(this,model.settings,model.player,danmaku); video.addView(overlay,FrameLayout.LayoutParams(-1,-1))
            val subtitles = SubtitleOverlay(this,model.settings); video.addView(subtitles,FrameLayout.LayoutParams(-1,-1))
            model.player.subtitleText = { text -> subtitles.text = text }
            val range = TextView(this).apply {
                setTextColor(Color.WHITE); textSize = 13f; fontFeatureSettings = "tnum"; visibility = View.GONE
                val density = resources.displayMetrics.density; setPadding((14*density).toInt(),(10*density).toInt(),(14*density).toInt(),(10*density).toInt())
                background = GradientDrawable().apply { setColor(Color.argb(158,0,0,0)); cornerRadius = 12*density }
            }
            video.addView(range,FrameLayout.LayoutParams(-2,-2,Gravity.TOP or Gravity.START))
            var videoAspect = 0.0
            val hideRange = Runnable { range.animate().alpha(0f).setDuration(400).withEndAction { range.visibility = View.GONE } }
            model.player.dynamicRange = { text ->
                // Like the iPad: top left, clear of the top bar, inside the picture when it is letterboxed.
                val density = resources.displayMetrics.density; val box = PlaybackContract.fit(video.width,video.height,videoAspect)
                range.layoutParams = (range.layoutParams as FrameLayout.LayoutParams).apply {
                    leftMargin = ((video.width - box.width)/2 + 24*density).toInt(); topMargin = maxOf(124*density,(video.height - box.height)/2 + 16*density).toInt()
                }
                range.text = text; range.removeCallbacks(hideRange); range.animate().cancel(); range.alpha = 1f; range.visibility = View.VISIBLE
                range.postDelayed(hideRange,4000)
            }
            model.player.displayHdr = { display?.isHdr == true }
            model.player.videoLayout = { aspect,embedded -> surface.aspect = if(embedded) aspect else 0.0; subtitles.aspect = aspect; videoAspect = aspect }
            controls = VideoControls(this,model.player,danmaku); video.addView(controls,FrameLayout.LayoutParams(-1,-1)); root.addView(video,FrameLayout.LayoutParams(-1,-1))
            progress = ProgressBar(this).apply { visibility = View.GONE }; root.addView(progress,FrameLayout.LayoutParams(64,64,Gravity.CENTER))
            bridge = BridgeDispatcher(this,model.settings,model.player); webHost = WebHost(this,web,model.settings,bridge); webHost.applySettings()
            updateListener = { state -> bridge.emit("system","appUpdateChanged",JSONArray().put(state)) }
            updates.engine.changed = updateListener!!
            setFullscreen(false)
            model.player.signal = { name,args -> bridge.emit("player",name,args) }
            model.player.message = { text -> notify(text) }
            model.player.notice = { text,ms -> controls.showNotice(text,ms) }
            model.player.introSkipChanged = { controls.refreshIntroSkip() }
            model.player.visible = { shown ->
                video.visibility = if(shown) View.VISIBLE else View.GONE
                setPlaybackScreenAwake(shown); setFullscreen(shown)
                if(shown) controls.showControls()
                if(!shown) { controls.playbackHidden(); range.removeCallbacks(hideRange); range.visibility = View.GONE }
                if(!shown && !model.player.state.active) { danmaku.clear(); beforePlaybackFullscreen = null; controls.unlockTouch() }
            }
            model.player.itemChanged = { item ->
                val episode = if(item.has("IndexNumber")) "S${item.optInt("ParentIndexNumber",1)} E${item.optInt("IndexNumber")}" else ""
                controls.setTitle(listOf(item.optString("SeriesName"),episode,item.optString("Name")).filter { it.isNotBlank() }.joinToString(" · "))
                controls.showControls(); danmaku.autoMatch(item)
                controls.playbackStarted()
            }
            model.settings.changed = { section,values -> bridge.emit("settings","sectionValueUpdate",JSONArray().put(section).put(values)); runOnUiThread { model.player.applySettings(); overlay.rebuild(); subtitles.invalidate(); if(section == "main") webHost.applySettings() } }
            danmaku.changed = { runOnUiThread { overlay.rebuild(); bridge.emit("danmaku","sourcesChanged",JSONArray().put(danmaku.sourceSnapshot())) } }
            danmaku.status = { text -> runOnUiThread { if(!controls.showDanmakuStatus(text)) notify(text); bridge.emit("danmaku","status",JSONArray().put(text)) } }
            root.setOnApplyWindowInsetsListener { _,insets -> currentInsets = insets; updateWindowMetrics(); insets }
            root.addOnLayoutChangeListener { _,_,_,_,_,_,_,_,_ -> updateWindowMetrics() }
            lifecycleScope.launch { WindowInfoTracker.getOrCreate(this@MainActivity).windowLayoutInfo(this@MainActivity).collect { info ->
                val fold = info.displayFeatures.filterIsInstance<FoldingFeature>().firstOrNull { it.isSeparating }
                hinge = if(fold == null) JSONObject() else JSONObject().put("left",fold.bounds.left).put("top",fold.bounds.top).put("right",fold.bounds.right).put("bottom",fold.bounds.bottom)
                updateWindowMetrics()
            } }
            getSystemService(DisplayManager::class.java).registerDisplayListener(this,android.os.Handler(mainLooper))
            onBackPressedDispatcher.addCallback(this,object: OnBackPressedCallback(true) { override fun handleOnBackPressed() {
                if(video.visibility == View.VISIBLE && playbackTouchLocked) { controls.showUnlock(); return }
                if(video.visibility == View.VISIBLE) { model.player.dispatch("stop",JSONArray(),"system back"); endPlaybackSession() }
                else if(model.player.state.active && model.player.isVideo()) { video.visibility = View.VISIBLE; setPlaybackScreenAwake(true); setFullscreen(true); controls.showControls() }
                else if(webHost.rollbackSelection(false)) return
                else web.evaluateJavascript("Boolean(window.tigerestServerSelectionBack?.() || window.tigerestClientMenuBack?.() || (window.TigerestHomeMotion && window.TigerestHomeMotion.handleNativeBack()))") { handled ->
                    if(handled != "true") { if(web.canGoBack()) web.goBack() else finish() }
                }
            } })
            if(BuildConfig.DEBUG && intent.hasExtra("url")) { val url = intent.getStringExtra("url")!!; model.settings.set("main","userWebClient",url); webHost.open(url) }
            else if(savedInstanceState != null) { webHost.restore(savedInstanceState) }
            else webHost.openSaved()
            if(model.player.state.active && model.player.isVideo()) {
                video.visibility = View.VISIBLE; setPlaybackScreenAwake(true); setFullscreen(true)
                val item = model.player.currentItem()
                val episode = if(item.has("IndexNumber")) "S${item.optInt("ParentIndexNumber",1)} E${item.optInt("IndexNumber")}" else ""
                controls.setTitle(listOf(item.optString("SeriesName"),episode,item.optString("Name")).filter { it.isNotBlank() }.joinToString(" · "))
                controls.showControls()
            }
        } catch(error: Exception) {
            DiagnosticsLog.app.record("error","Activity initialization failed: ${error.javaClass.simpleName}")
            setContentView(TextView(this).apply { setTextColor(Color.WHITE); setBackgroundColor(Color.rgb(16,16,16)); textSize = 18f; gravity = Gravity.CENTER; text = "客户端初始化失败\n${error.message}" })
            android.util.Log.e("TigerestAndroid","Initialization failed",error)
        }
    }
    fun input(action: String) { bridge.emit("input","hostInput",JSONArray().put(JSONArray().put(action))) }
    fun selectPlaylistItem(id: String) { bridge.emit("input","playlistItemRequested",JSONArray().put(id)) }
    fun bitrate(value: Long) { bridge.emit("player","streamingBitrateRequested",JSONArray().put(value)) }
    fun subtitle(index: Int) { bridge.emit("player","subtitleStreamRequested",JSONArray().put(index)) }
    private fun bounds(value: Pane) = JSONObject().put("left",value.left).put("top",value.top).put("right",value.right).put("bottom",value.bottom)
    fun diagnostics(): JSONObject = JSONObject().put("platform","Android").put("version",android.os.Build.VERSION.RELEASE).put("sdk",android.os.Build.VERSION.SDK_INT).put("width",root.width).put("height",root.height).put("density",resources.displayMetrics.density).put("paused",model.player.state.paused).put("active",model.player.state.active).put("videoVisible",video.visibility == View.VISIBLE).put("controlsVisible",controls.controlsVisible()).put("danmakuFrames",overlay.drawnFrames).put("refreshRate",display?.refreshRate ?: 60f)
        .put("danmakuMotionFrames",overlay.motionFrames).put("danmakuPosition",overlay.renderedPosition)
        .put("windowBrightness",controls.windowBrightness()).put("effectiveBrightness",controls.effectiveBrightness()).put("mediaVolume",controls.mediaVolume())
        .put("fullscreen",fullscreen).put("pane",bounds(currentPane)).put("safeContent",bounds(safeContent)).put("videoBounds",bounds(Pane(video.left,video.top,video.right,video.bottom))).put("controls",controls.diagnostics(video.left,video.top))
        .put("requestedOrientation",requestedOrientation).put("displayRotation",display?.rotation ?: 0).put("automaticRotation",Settings.System.getInt(contentResolver,Settings.System.ACCELEROMETER_ROTATION,1) != 0)
    fun loading(active: Boolean) { if(::progress.isInitialized) progress.visibility = if(active) View.VISIBLE else View.GONE }
    fun webError(message: String) { loading(false); notify(message) }
    fun notify(message: String) { if(!isFinishing) Toast.makeText(this,message,Toast.LENGTH_LONG).show() }
    fun openExternal(url: String) { runCatching { startActivity(Intent(Intent.ACTION_VIEW,Uri.parse(url))) }.onFailure { notify("没有可打开链接的浏览器") } }
    fun chooseWebFile(callback: ValueCallback<Array<Uri>>,intent: Intent) { webFileCallback?.onReceiveValue(null); webFileCallback = callback; webFile.launch(intent) }
    fun editServerAddress(initial: String, complete: (String?) -> Unit) {
        serverAddressDialog?.dismiss()
        val editor = EditText(this).apply {
            setSingleLine(true)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_DONE
            hint = "https://example.org:8920/jellyfin/"
            setText(initial); setSelection(text.length)
        }
        val padding = (20 * resources.displayMetrics.density).toInt()
        val content = FrameLayout(this).apply { setPadding(padding,0,padding,0); addView(editor,FrameLayout.LayoutParams(-1,-2)) }
        var accepted = false
        val dialog = android.app.AlertDialog.Builder(this)
            .setTitle("服务器地址").setView(content)
            .setPositiveButton("使用此地址") { _,_ -> accepted = true }
            .setNegativeButton("取消",null).create()
        dialog.setOnDismissListener {
            if(serverAddressDialog === dialog) serverAddressDialog = null
            complete(if(accepted) editor.text.toString() else null)
        }
        editor.setOnEditorActionListener { _,action,_ ->
            if(action == android.view.inputmethod.EditorInfo.IME_ACTION_DONE) { accepted = true; dialog.dismiss(); true } else false
        }
        serverAddressDialog = dialog
        dialog.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE or WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        dialog.show(); editor.requestFocus()
    }
    fun chooseDanmakuFile() { importToken = danmaku.currentToken(); danmakuFile.launch(arrayOf("text/*","application/json","application/xml","application/octet-stream")) }
    fun toggleDanmaku() { model.settings.set("mpv","enableDanmaku",!model.settings.bool("mpv","enableDanmaku")); overlay.rebuild() }
    fun showWebSettings(section: String = "video") {
        video.visibility = View.GONE
        controls.playbackHidden()
        setFullscreen(false)
        // The same settings component is available before and after Emby login.
        webHost.view.evaluateJavascript("(async()=>{const panel=await window.tigerestMountSettings?.(null,${JSONObject.quote(section)});if(!panel)return;const observer=new MutationObserver(()=>{if(!document.getElementById('tigerest-settings-overlay')){observer.disconnect();window.tigerestAndroidApi.player.setVideoOnlyMode(true)}});observer.observe(document.body,{childList:true});})()",null)
    }
    fun setPlaybackScreenAwake(active: Boolean) { if(active) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
    fun beginPlaybackSession() { if(beforePlaybackFullscreen == null) beforePlaybackFullscreen = false; setPlaybackScreenAwake(true); setFullscreen(true) }
    fun endPlaybackSession() { beforePlaybackFullscreen?.let { setFullscreen(it) }; beforePlaybackFullscreen = null; setPlaybackScreenAwake(false); if(::controls.isInitialized) controls.unlockTouch() }
    private fun syncSystemRotation() {
        val automatic = Settings.System.getInt(contentResolver,Settings.System.ACCELEROMETER_ROTATION,1) != 0
        val rotation = display?.rotation ?: 0
        val reverse = rotation >= 2
        val direction = if(resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE) {
            if(reverse) ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE else ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        } else if(reverse) ActivityInfo.SCREEN_ORIENTATION_REVERSE_PORTRAIT else ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        val requested = model.rotation.update(automatic,direction)
        if(requestedOrientation != requested) requestedOrientation = requested
    }
    fun setFullscreen(enabled: Boolean) {
        fullscreen = enabled
        // The default rotation animation shows an SDR screenshot, which drops the panel out of HDR for a moment.
        window.attributes = window.attributes.apply { rotationAnimation = if(enabled) WindowManager.LayoutParams.ROTATION_ANIMATION_SEAMLESS else WindowManager.LayoutParams.ROTATION_ANIMATION_ROTATE }
        window.insetsController?.let { controller -> controller.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE; if(enabled) controller.hide(WindowInsets.Type.systemBars()) else controller.show(WindowInsets.Type.systemBars()) }
        if(::bridge.isInitialized) bridge.emit("window","fullScreenSwitched",JSONArray().put(enabled))
    }
    fun updateWindowMetrics() {
        if(!::webHost.isInitialized) return
        val width = root.width
        val height = root.height
        val fold = if(hinge.has("left")) Pane(hinge.getInt("left"),hinge.getInt("top"),hinge.getInt("right"),hinge.getInt("bottom")) else null
        val pane = WindowLayout.pane(width,height,fold)
        currentPane = pane
        val insets = currentInsets ?: root.rootWindowInsets
        val safe = insets?.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout()) ?: android.graphics.Insets.NONE
        val caption = insets?.getInsets(WindowInsets.Type.captionBar()) ?: android.graphics.Insets.NONE
        val ime = insets?.getInsets(WindowInsets.Type.ime()) ?: android.graphics.Insets.NONE
        safeContent = WindowLayout.safeContent(pane,width,height,EdgeInsets(safe.left,safe.top,safe.right,safe.bottom))
        // Surfaces fill the pane. Only interactive content avoids cutouts; IME/caption are real occlusion.
        for(child in listOf(webHost.view,video)) {
            val available = WindowLayout.safeContent(pane,width,height,EdgeInsets(caption.left,caption.top,caption.right,maxOf(caption.bottom,if(child === webHost.view) ime.bottom else 0)))
            val old = child.layoutParams as FrameLayout.LayoutParams
            val w = available.right-available.left; val h = available.bottom-available.top
            if(old.width != w || old.height != h || old.leftMargin != available.left || old.topMargin != available.top) child.layoutParams = FrameLayout.LayoutParams(w,h).apply { leftMargin = available.left; topMargin = available.top }
        }
        val videoPane = WindowLayout.safeContent(pane,width,height,EdgeInsets(caption.left,caption.top,caption.right,caption.bottom))
        controls.applySafeInsets(EdgeInsets((safeContent.left-videoPane.left).coerceAtLeast(0),(safeContent.top-videoPane.top).coerceAtLeast(0),(videoPane.right-safeContent.right).coerceAtLeast(0),(videoPane.bottom-safeContent.bottom).coerceAtLeast(0)))
        val density = resources.displayMetrics.density
        val metrics = windowManager.currentWindowMetrics
        val webPane = WindowLayout.safeContent(pane,width,height,EdgeInsets(caption.left,caption.top,caption.right,maxOf(caption.bottom,ime.bottom)))
        val webSafe = JSONObject().put("left",(safeContent.left-webPane.left).coerceAtLeast(0)/density).put("top",(safeContent.top-webPane.top).coerceAtLeast(0)/density).put("right",(webPane.right-safeContent.right).coerceAtLeast(0)/density).put("bottom",(webPane.bottom-safeContent.bottom).coerceAtLeast(0)/density)
        val value = JSONObject().put("width",(webPane.right-webPane.left)/density).put("height",(webPane.bottom-webPane.top)/density).put("safeInsets",webSafe).put("density",density).put("displayId",display?.displayId ?: 0).put("refreshRate",display?.refreshRate ?: 60f).put("hinge",hinge).put("boundsWidth",metrics.bounds.width()).put("boundsHeight",metrics.bounds.height())
        val js = "window.tigerestWindowMetrics=$value;if(document.documentElement)document.documentElement.dataset.tigerestWindow=window.innerWidth<600?'compact':window.innerWidth<840?'medium':'expanded';window.dispatchEvent(new CustomEvent('tigerest-window-changed',{detail:window.tigerestWindowMetrics}));"
        webHost.view.evaluateJavascript(js,null)
    }
    override fun onConfigurationChanged(newConfig: Configuration) { super.onConfigurationChanged(newConfig); syncSystemRotation(); root.requestApplyInsets(); updateWindowMetrics(); if(::overlay.isInitialized) overlay.rebuild(); if(::controls.isInitialized) controls.refreshMetrics() }
    override fun onDisplayAdded(displayId: Int) { updateWindowMetrics() }
    override fun onDisplayRemoved(displayId: Int) { updateWindowMetrics() }
    override fun onDisplayChanged(displayId: Int) { syncSystemRotation(); updateWindowMetrics() }
    override fun onResume() { super.onResume(); syncSystemRotation(); DiagnosticsLog.app.record("info","Activity resumed"); updates.resumed(this) }
    override fun onPause() { DiagnosticsLog.app.record("info","Activity paused"); if(::controls.isInitialized) controls.cancelGesture(); updates.paused(this); super.onPause() }
    override fun onStop() { super.onStop(); DiagnosticsLog.app.record("info","Activity stopped"); if(::webHost.isInitialized) { controls.playbackHidden();if(!isChangingConfigurations) model.player.background() } }
    override fun onSaveInstanceState(outState: Bundle) { if(::webHost.isInitialized) webHost.view.saveState(outState); super.onSaveInstanceState(outState) }
    override fun onDestroy() { serverAddressDialog?.dismiss(); contentResolver.unregisterContentObserver(rotationObserver); if(updates.engine.changed === updateListener) updates.engine.changed = {}; updates.paused(this); getSystemService(DisplayManager::class.java).unregisterDisplayListener(this); webFileCallback?.onReceiveValue(null); if(::bridge.isInitialized) bridge.close(); if(::webHost.isInitialized) webHost.close(); super.onDestroy() }
}
