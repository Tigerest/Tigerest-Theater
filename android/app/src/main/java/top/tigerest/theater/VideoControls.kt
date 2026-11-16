package top.tigerest.theater

import android.app.AlertDialog
import android.graphics.Color
import android.graphics.Rect
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.content.res.ColorStateList
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.MotionEvent
import android.widget.*
import org.json.JSONArray
import org.json.JSONObject
import kotlin.concurrent.thread

class VideoControls(private val activity: MainActivity,private val player: PlaybackController,private val repository: DanmakuRepository) : FrameLayout(activity) {
    private val title = TextView(activity).apply { setTextColor(Color.WHITE); textSize = 16f; maxLines = 1; ellipsize = TextUtils.TruncateAt.END; gravity = Gravity.CENTER_VERTICAL }
    private val time = TextView(activity).apply { setTextColor(Color.WHITE); textSize = 13f }
    private val pause = button("暂停") { player.dispatch(if(player.state.paused) "play" else "pause",JSONArray()) }
    private val seek = SeekBar(activity).apply { contentDescription = "播放进度"; minimumHeight = dp(48) }
    private var dragging = false
    private val controls = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,intArrayOf(0x10101010,0xe0101010.toInt())) }
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())
    private lateinit var header: LinearLayout
    private var lastPaused = true
    private var touching = false
    private var safeInsets = EdgeInsets()
    private var menuOpen = false
    private var unlockingTouch = false
    private val previous = button("上一集") { episodeQueue().previousId?.let(activity::selectPlaylistItem) }
    private val next = button("下一集") { episodeQueue().nextId?.let(activity::selectPlaylistItem) }
    private val episodes = button("选集") { episodeMenu() }
    private val unlock = button("长按解锁") { showUnlock() }.apply {
        visibility = View.GONE
        contentDescription = "长按解除防误触锁"
        setOnLongClickListener { unlockTouch(); true }
    }
    private val loadingLabel = TextView(activity).apply {
        setTextColor(Color.WHITE); textSize = 14f; gravity = Gravity.CENTER
    }
    private val loadingIndicator = LinearLayout(activity).apply {
        orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER
        setPadding(dp(24),dp(20),dp(24),dp(18))
        background = GradientDrawable().apply { setColor(0xc0101010.toInt()); cornerRadius = dp(16).toFloat() }
        visibility = View.GONE; importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        addView(ProgressBar(activity).apply {
            isIndeterminate = true; indeterminateTintList = ColorStateList.valueOf(Color.rgb(255,190,56))
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        },LinearLayout.LayoutParams(dp(44),dp(44)))
        addView(loadingLabel,LinearLayout.LayoutParams(LayoutParams.WRAP_CONTENT,LayoutParams.WRAP_CONTENT).apply { topMargin = dp(12) })
    }
    private val gestureFeedback = TextView(activity).apply {
        setTextColor(Color.WHITE); textSize=20f; gravity=Gravity.CENTER; setPadding(dp(20),dp(14),dp(20),dp(14))
        background=GradientDrawable().apply { setColor(0xdc101010.toInt());cornerRadius=dp(14).toFloat() };visibility=View.GONE
        importantForAccessibility=View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    private val hideFeedback = Runnable { gestureFeedback.visibility=View.GONE }
    private val danmakuStatus = TextView(activity).apply {
        setTextColor(Color.WHITE);textSize=14f;gravity=Gravity.CENTER
        setPadding(dp(16),dp(12),dp(16),dp(12));visibility=View.GONE
        background=GradientDrawable().apply { setColor(0xdc101010.toInt());cornerRadius=dp(12).toFloat() }
        accessibilityLiveRegion=View.ACCESSIBILITY_LIVE_REGION_POLITE
    }
    private val hideDanmakuStatus = Runnable { danmakuStatus.visibility=View.GONE }
    private val gestures = PlayerGestures(activity,player,{ performClick() },{ text ->
        handler.removeCallbacks(hideFeedback);gestureFeedback.text=text;gestureFeedback.visibility=if(text.isEmpty()) View.GONE else View.VISIBLE
        if(text.isNotEmpty() && !touching) handler.postDelayed(hideFeedback,1000)
    })
    private val hide = Runnable { if(!dragging && !touching && !menuOpen && hasWindowFocus() && !player.state.paused) setControlsVisible(false) }
    private fun setControlsVisible(shown: Boolean) { header.visibility = if(shown && !activity.playbackTouchLocked) View.VISIBLE else View.GONE; controls.visibility = header.visibility }
    private fun scheduleHide() { handler.removeCallbacks(hide); if(!player.state.paused && !dragging && !touching && !menuOpen) handler.postDelayed(hide,3500) }
    fun showControls() { if(activity.playbackTouchLocked) { setControlsVisible(false); showUnlock() } else { setControlsVisible(true); updateLoadingIndicator(); scheduleHide() } }
    fun showUnlock() { unlock.visibility = if(activity.playbackTouchLocked) View.VISIBLE else View.GONE }
    private fun lockTouch() {
        cancelGesture(); handler.removeCallbacks(hide); handler.removeCallbacks(hideFeedback); gestureFeedback.visibility = View.GONE
        activity.playbackTouchLocked = true; setControlsVisible(false); showUnlock()
        unlock.announceForAccessibility("防误触已开启，长按解锁")
    }
    fun unlockTouch() { activity.playbackTouchLocked = false; unlock.visibility = View.GONE; if(player.state.active) showControls() }
    fun controlsVisible() = controls.visibility == View.VISIBLE
    fun playbackStarted() { post { if(player.state.active && player.isVideo()) gestures.playbackStarted() } }
    fun cancelGesture() { touching = false; gestures.cancelTouch() }
    fun playbackHidden() { touching = false; gestures.suspend();gestureFeedback.visibility=View.GONE;loadingIndicator.visibility=View.GONE;handler.removeCallbacks(hideDanmakuStatus);danmakuStatus.visibility=View.GONE }
    fun showDanmakuStatus(text: String): Boolean {
        if(!player.state.active || !player.isVideo() || visibility!=View.VISIBLE) return false
        handler.removeCallbacks(hideDanmakuStatus);danmakuStatus.text=text;danmakuStatus.visibility=View.VISIBLE
        handler.postDelayed(hideDanmakuStatus,5000)
        return true
    }
    private fun updateLoadingIndicator() {
        val shown = player.isVideo() && player.state.loading
        loadingIndicator.visibility = if(shown) View.VISIBLE else View.GONE
        if(shown) {
            val label = if(player.state.opening) "正在加载视频…" else "正在缓冲…"
            loadingLabel.text = label; loadingIndicator.contentDescription = label
        }
    }
    fun windowBrightness() = gestures.brightness()
    fun effectiveBrightness() = gestures.effectiveBrightness()
    fun mediaVolume() = gestures.volume()
    fun refreshMetrics() {
        gestures.cancelTouch()
        applySafeInsets(safeInsets)
        seek.minimumHeight = dp(48)
        seek.layoutParams = seek.layoutParams.apply { height = dp(48) }
        title.textSize = 16f; time.textSize = 13f;gestureFeedback.textSize=20f
        pause.layoutParams = (pause.layoutParams as LinearLayout.LayoutParams).apply { width = dp(96); height = dp(48); leftMargin = dp(12); rightMargin = dp(12) }
        fun visit(view: View) { if(view is Button) { view.textSize = 14f; view.minWidth = dp(64); view.minimumWidth = dp(64); view.minHeight = dp(48); view.minimumHeight = dp(48); view.setPadding(dp(10),0,dp(10),0); view.layoutParams?.takeIf { it.height>0 }?.let { view.layoutParams = it.apply { height = dp(48) } } }; if(view is android.view.ViewGroup) for(index in 0 until view.childCount) visit(view.getChildAt(index)) }
        visit(this)
    }
    fun applySafeInsets(value: EdgeInsets) {
        safeInsets = value
        header.layoutParams = (header.layoutParams as LayoutParams).apply { height = dp(64)+value.top }
        header.setPadding(value.left+dp(8),value.top+dp(8),value.right+dp(8),dp(8))
        controls.setPadding(value.left+dp(12),dp(8),value.right+dp(12),value.bottom+dp(8))
        if(unlock.parent != null) unlock.layoutParams = (unlock.layoutParams as LayoutParams).apply { leftMargin=value.left+dp(8); topMargin=value.top; bottomMargin=value.bottom }
    }
    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if(activity.playbackTouchLocked) {
            if(event.actionMasked == MotionEvent.ACTION_DOWN) unlockingTouch = event.x >= unlock.left && event.x <= unlock.right && event.y >= unlock.top && event.y <= unlock.bottom
            val handled = if(unlockingTouch) super.dispatchTouchEvent(event) else { showUnlock(); true }
            if(event.actionMasked in listOf(MotionEvent.ACTION_UP,MotionEvent.ACTION_CANCEL)) unlockingTouch = false
            return handled
        }
        if(event.actionMasked == MotionEvent.ACTION_DOWN) { touching = true; handler.removeCallbacks(hide) }
        val handled = super.dispatchTouchEvent(event)
        if(event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) { touching = false; scheduleHide(); if(gestureFeedback.visibility==View.VISIBLE) handler.postDelayed(hideFeedback,1000) }
        return handled
    }
    override fun onTouchEvent(event: MotionEvent): Boolean {
        if(activity.playbackTouchLocked) { showUnlock(); return true }
        val edge=dp(24)
        val allowed=event.x>safeInsets.left+edge && event.x<width-safeInsets.right-edge && event.y>safeInsets.top+edge && event.y<height-safeInsets.bottom-edge &&
            (!controlsVisible() || event.y>header.bottom && event.y<controls.top)
        return gestures.touch(event,width,height,allowed)
    }
    override fun performClick(): Boolean { super.performClick();return true }
    private val update = object: Runnable { override fun run() {
        if(!isAttachedToWindow) return
        updateLoadingIndicator()
        gestures.refreshPlayback()
        if(lastPaused != player.state.paused) { lastPaused = player.state.paused; showControls() }
        val duration = player.dispatch("getDuration",JSONArray()) as Long
        val position = player.state.positionMs
        if(!dragging) { seek.max = (duration/1000).toInt().coerceAtLeast(1); seek.progress = (position/1000).toInt() }
        if(!dragging) time.text = "${format(position)} / ${format(duration)}   ${player.state.speed}×"
        pause.text = if(player.state.paused) "播放" else "暂停"
        val queue = episodeQueue()
        previous.isEnabled = queue.previousId != null; next.isEnabled = queue.nextId != null; episodes.isEnabled = queue.items.isNotEmpty()
        previous.alpha = if(previous.isEnabled) 1f else .35f; next.alpha = if(next.isEnabled) 1f else .35f; episodes.alpha = if(episodes.isEnabled) 1f else .35f
        handler.postDelayed(this,400)
    } }
    init {
        isClickable = true
        setOnClickListener { if(activity.playbackTouchLocked) showUnlock() else if(controls.visibility == View.VISIBLE) { handler.removeCallbacks(hide); setControlsVisible(false) } else showControls() }
        header = LinearLayout(activity).apply { gravity = Gravity.CENTER_VERTICAL; background = GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,intArrayOf(0xd0101010.toInt(),0x10101010)) }
        header.addView(button("返回") { player.dispatch("stop",JSONArray(),"player back button"); activity.endPlaybackSession() })
        header.addView(title,LinearLayout.LayoutParams(0,LayoutParams.MATCH_PARENT,1f))
        header.addView(button("防误触") { lockTouch() })
        addView(header,LayoutParams(LayoutParams.MATCH_PARENT,dp(64),Gravity.TOP))
        controls.addView(time); controls.addView(seek,LinearLayout.LayoutParams(-1,dp(48)))
        seek.setOnSeekBarChangeListener(object: SeekBar.OnSeekBarChangeListener {
            override fun onStartTrackingTouch(bar: SeekBar) { gestures.cancelTouch(); dragging = true; handler.removeCallbacks(hide) }
            override fun onStopTrackingTouch(bar: SeekBar) { dragging = false; player.dispatch("seekTo",JSONArray().put(bar.progress*1000L)); scheduleHide() }
            override fun onProgressChanged(bar: SeekBar,progress: Int,fromUser: Boolean) { if(fromUser) time.text = "${format(progress*1000L)} / ${format(bar.max*1000L)}" }
        })
        val transport = LinearLayout(activity).apply { gravity = Gravity.CENTER }
        transport.addView(button("−10 秒") { skip(-10000) })
        transport.addView(pause,LinearLayout.LayoutParams(dp(96),dp(48)).apply { leftMargin = dp(12); rightMargin = dp(12) })
        transport.addView(button("+10 秒") { skip(10000) })
        controls.addView(transport)
        val episodeActions = LinearLayout(activity).apply { gravity = Gravity.CENTER_VERTICAL }
        for(action in listOf(previous,episodes,next)) episodeActions.addView(action,LinearLayout.LayoutParams(0,dp(48),1f))
        controls.addView(episodeActions)
        val actions = LinearLayout(activity).apply { gravity = Gravity.CENTER_VERTICAL }
        for(action in listOf(button("弹幕") { danmakuMenu() },button("倍速") { speedMenu() },button("更多") { moreMenu() })) actions.addView(action,LinearLayout.LayoutParams(0,dp(48),1f))
        controls.addView(actions); addView(controls,LayoutParams(LayoutParams.MATCH_PARENT,LayoutParams.WRAP_CONTENT,Gravity.BOTTOM))
        addView(loadingIndicator,LayoutParams(LayoutParams.WRAP_CONTENT,LayoutParams.WRAP_CONTENT,Gravity.CENTER))
        addView(gestureFeedback,LayoutParams(LayoutParams.WRAP_CONTENT,LayoutParams.WRAP_CONTENT,Gravity.CENTER))
        addView(danmakuStatus,LayoutParams(LayoutParams.MATCH_PARENT,LayoutParams.WRAP_CONTENT,Gravity.TOP).apply { topMargin=dp(76);leftMargin=dp(16);rightMargin=dp(16) })
        addView(unlock,LayoutParams(LayoutParams.WRAP_CONTENT,dp(48),Gravity.START or Gravity.CENTER_VERTICAL).apply { leftMargin=dp(8) })
        setControlsVisible(!activity.playbackTouchLocked)
        showUnlock()
        applySafeInsets(safeInsets)
    }
    private fun skip(delta: Long) { val duration = player.dispatch("getDuration",JSONArray()) as Long; player.dispatch("seekTo",JSONArray().put((player.state.positionMs+delta).coerceIn(0,duration.coerceAtLeast(0)))) }
    private fun speedMenu() { val values = doubleArrayOf(.5,.75,1.0,1.25,1.5,1.75,2.0,2.5,3.0,4.0); AlertDialog.Builder(activity).setTitle("播放速度").setSingleChoiceItems(values.map { "$it×" }.toTypedArray(),values.indexOfFirst { kotlin.math.abs(it-player.state.speed)<.01 }) { dialog,index -> player.dispatch("setPlaybackRate",JSONArray().put(values[index]*1000)); dialog.dismiss() }.show() }
    private fun moreMenu() {
        AlertDialog.Builder(activity).setTitle("播放选项").setItems(arrayOf("音轨","字幕","字幕偏移","画质","播放器设置","手势教程")) { _,index -> when(index) {
            0 -> tracks("audio"); 1 -> tracks("sub"); 2 -> subtitleOffset()
            3 -> { val rates = longArrayOf(0,4000000,8000000,15000000,25000000,40000000); AlertDialog.Builder(activity).setTitle("播放画质").setItems(arrayOf("自动","4 Mbps","8 Mbps","15 Mbps","25 Mbps","40 Mbps")) { _,choice -> activity.bitrate(rates[choice]) }.show() }
            4 -> { player.dispatch("pause",JSONArray()); activity.showWebSettings() }
            5 -> gestures.showTutorial()
        } }.show()
    }
    private fun episodeQueue() = EpisodeQueue.from(player.dispatch("getWebPlaylist",JSONArray()) as JSONArray,player.dispatch("getCurrentWebPlaylistItemId",JSONArray()) as String)
    private fun episodeMenu() {
        val queue = episodeQueue()
        if(queue.items.isEmpty()) { activity.notify("当前播放队列没有可选剧集"); return }
        menuOpen = true; handler.removeCallbacks(hide)
        AlertDialog.Builder(activity).setTitle("选集").setSingleChoiceItems(queue.items.map { it.label }.toTypedArray(),queue.currentIndex) { dialog,index ->
            if(queue.items[index].id != episodeQueue().items.getOrNull(episodeQueue().currentIndex)?.id) activity.selectPlaylistItem(queue.items[index].id)
            dialog.dismiss()
        }.setNegativeButton("取消",null).create().apply { setOnDismissListener { menuOpen=false; scheduleHide() }; show() }
    }
    private fun dp(value: Int) = (value*resources.displayMetrics.density).toInt()
    private fun button(label: String,action: () -> Unit) = Button(activity).apply {
        text = label; textSize = 14f; isAllCaps = false; setSingleLine(); setTextColor(Color.rgb(255,190,56)); minWidth = dp(64); minimumWidth = dp(64); minHeight = dp(48); minimumHeight = dp(48); setPadding(dp(10),0,dp(10),0)
        val shape = GradientDrawable().apply { cornerRadius = dp(12).toFloat(); setColor(0x18181818) }
        background = RippleDrawable(ColorStateList.valueOf(0x40ffbe38),shape,null)
        setOnClickListener { runCatching(action).onFailure { activity.notify(it.message ?: "操作失败") } }
    }
    fun diagnostics(x: Int,y: Int): JSONObject {
        fun rect(view: View): JSONObject { val r = Rect(); view.getDrawingRect(r); offsetDescendantRectToMyCoords(view,r); r.offset(x,y); return JSONObject().put("left",r.left).put("top",r.top).put("right",r.right).put("bottom",r.bottom).put("width",r.width()).put("height",r.height()) }
        val buttons = JSONArray()
        fun visit(view: View) { if(view is Button && view.isShown) buttons.put(rect(view).put("label",view.text)); if(view is android.view.ViewGroup) for(i in 0 until view.childCount) visit(view.getChildAt(i)) }
        visit(this)
        return JSONObject().put("header",rect(header)).put("bottom",rect(controls)).put("seek",rect(seek)).put("buttons",buttons).put("dragging",dragging).put("time",time.text).put("gesture",if(gestureFeedback.isShown) gestureFeedback.text else "").put("touchLocked",activity.playbackTouchLocked)
            .put("loading",loadingIndicator.isShown).put("opening",player.state.opening).put("speed",player.state.speed).put("temporarySpeed",player.temporarySpeedActive)
    }
    fun setTitle(value: String) { title.text = value }
    private fun tracks(type: String) {
        if(type == "sub") {
            val streams = player.dispatch("getSubtitleStreams",JSONArray()) as JSONArray
            if(streams.length() > 0) {
                val labels = arrayOf("关闭字幕") + (0 until streams.length()).map { streams.getJSONObject(it).optString("title","字幕") }.toTypedArray()
                AlertDialog.Builder(activity).setTitle("字幕").setItems(labels) { _,index -> activity.subtitle(if(index == 0) -1 else streams.getJSONObject(index-1).getInt("index")) }.show()
                return
            }
        }
        val raw = player.tracks(); val tracks = (0 until raw.length()).map { raw.getJSONObject(it) }.filter { it.optString("type") == type }
        val labels = tracks.map { "${it.optString("title",if(type == "audio") "音轨" else "字幕")} · ${it.optString("lang","未标注语言")} #${it.optInt("id")}" }.toMutableList()
        if(type == "sub") labels.add(0,"关闭字幕")
        if(labels.isEmpty()) { activity.notify("没有可用音轨"); return }
        AlertDialog.Builder(activity).setTitle(if(type == "audio") "音轨" else "字幕").setItems(labels.toTypedArray()) { _,index ->
            val id = if(type == "sub" && index == 0) -1 else tracks[index-if(type == "sub") 1 else 0].getInt("id")
            player.dispatch(if(type == "audio") "setAudioStream" else "setSubtitleStream",JSONArray().put(id))
        }.show()
    }
    private fun subtitleOffset() {
        val info = player.dispatch("mpvDiagnostics",JSONArray()) as org.json.JSONObject
        val input = EditText(activity).apply { inputType = android.text.InputType.TYPE_CLASS_NUMBER or android.text.InputType.TYPE_NUMBER_FLAG_DECIMAL or android.text.InputType.TYPE_NUMBER_FLAG_SIGNED; setText(info.optDouble("subtitleDelay").toString()) }
        AlertDialog.Builder(activity).setTitle("字幕偏移（秒，正值延后）").setView(input).setPositiveButton("保存") { _,_ ->
            val seconds = input.text.toString().toDoubleOrNull()
            if(seconds != null && seconds.isFinite() && seconds in -600.0..600.0) player.dispatch("setSubtitleDelay",JSONArray().put(seconds*1000)) else activity.notify("请输入 -600 到 600 秒")
        }.setNeutralButton("重置") { _,_ -> player.dispatch("setSubtitleDelay",JSONArray().put(0)) }.setNegativeButton("取消",null).show()
    }
    private fun danmakuMenu() {
        AlertDialog.Builder(activity).setTitle("弹幕").setItems(arrayOf("开启／关闭弹幕","搜索弹幕","来源、屏蔽与时间偏移","导入 XML / JSON / ASS","弹幕样式","添加视频网站来源")) { _,index -> when(index) {
            0 -> activity.toggleDanmaku(); 1 -> searchDialog(); 2 -> sourceDialog(); 3 -> activity.chooseDanmakuFile(); 4 -> { player.dispatch("pause",JSONArray()); activity.showWebSettings("danmaku") }
            5 -> { val url = EditText(activity).apply { hint = "HTTP(S) 视频页面网址"; inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI }; AlertDialog.Builder(activity).setTitle("添加弹幕来源").setView(url).setPositiveButton("加载") { _,_ -> network { repository.loadUrl(url.text.toString()) } }.setNegativeButton("取消",null).show() }
        } }.show()
    }
    private fun searchDialog() {
        val token = repository.currentToken()
        val input = EditText(activity).apply { hint = "作品名称"; setSingleLine() }
        AlertDialog.Builder(activity).setTitle("搜索弹幕").setView(input).setPositiveButton("搜索") { _,_ -> network {
            val result = repository.search(input.text.toString())
            activity.runOnUiThread { if(!repository.isCurrent(token)) return@runOnUiThread; selectArray("选择作品",result,"animeTitle") chooseAnime@ { index ->
                if(!repository.isCurrent(token)) return@chooseAnime
                val anime = result.getJSONObject(index); val id = anime.get("bangumiId").toString()
                network fetchEpisodes@ { if(!repository.isCurrent(token)) return@fetchEpisodes; val episodes = repository.episodes(id); activity.runOnUiThread episodeUi@ { if(!repository.isCurrent(token)) return@episodeUi; selectArray("选择集数",episodes,"episodeTitle") chooseEpisode@ { episode ->
                    if(!repository.isCurrent(token)) return@chooseEpisode
                    val selected = episodes.getJSONObject(episode)
                    network { repository.selectEpisode(id,selected.get("episodeId").toString(),selected.optString("episodeTitle"),token) }
                } } }
            } }
        } }.setNegativeButton("取消",null).show()
    }
    private fun selectArray(title: String,array: JSONArray,key: String,selected: (Int) -> Unit) {
        if(array.length() == 0) { activity.notify("没有搜索结果"); return }
        if(activity.isFinishing) return
        AlertDialog.Builder(activity).setTitle(title).setItems((0 until array.length()).map { array.getJSONObject(it).optString(key,"未命名") }.toTypedArray()) { _,index -> selected(index) }.show()
    }
    private fun sourceDialog() {
        val sources = repository.sources
        if(sources.isEmpty()) { activity.notify("尚未加载弹幕，请先搜索或导入"); return }
        AlertDialog.Builder(activity).setTitle("弹幕来源").setItems(sources.map { "${if(it.enabled) "显示" else "屏蔽"} · ${it.title} · 偏移 ${it.delay}s" }.toTypedArray()) { _,index ->
            val source = sources[index]; val input = EditText(activity).apply { inputType = android.text.InputType.TYPE_CLASS_NUMBER or android.text.InputType.TYPE_NUMBER_FLAG_DECIMAL or android.text.InputType.TYPE_NUMBER_FLAG_SIGNED; setText(source.delay.toString()) }
            AlertDialog.Builder(activity).setTitle("时间偏移（秒）").setView(input).setPositiveButton("保存") { _,_ -> runCatching { repository.sourceSetting(source.id,source.enabled,input.text.toString().toDouble()) }.onFailure { activity.notify("请输入 -3600 到 3600 秒") } }
                .setNeutralButton(if(source.enabled) "屏蔽此源" else "显示此源") { _,_ -> repository.sourceSetting(source.id,!source.enabled,source.delay) }.setNegativeButton("取消",null).show()
        }.show()
    }
    private fun network(action: () -> Unit) { thread { runCatching(action).onFailure { activity.runOnUiThread { activity.notify(it.message ?: "弹幕服务暂不可用") } } } }
    override fun onAttachedToWindow() { super.onAttachedToWindow(); handler.post(update) }
    override fun onWindowFocusChanged(hasWindowFocus: Boolean) { super.onWindowFocusChanged(hasWindowFocus); menuOpen = !hasWindowFocus; if(hasWindowFocus && visibility == View.VISIBLE) showControls() else { cancelGesture(); handler.removeCallbacks(hide) } }
    override fun onDetachedFromWindow() { handler.removeCallbacks(update); handler.removeCallbacks(hide);handler.removeCallbacks(hideFeedback);handler.removeCallbacks(hideDanmakuStatus);gestures.suspend(); super.onDetachedFromWindow() }
    private fun format(ms: Long): String { val seconds = ms/1000; return "%d:%02d".format(seconds/60,seconds%60) }
}
