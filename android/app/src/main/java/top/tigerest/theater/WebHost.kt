package top.tigerest.theater

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

@SuppressLint("SetJavaScriptEnabled")
class WebHost(private val activity: MainActivity, val view: WebView, private val settings: SettingsStore, private val bridge: BridgeDispatcher) {
    companion object { const val ASSET_ORIGIN = "https://appassets.androidplatform.net"; const val ONBOARDING = "$ASSET_ORIGIN/assets/shared/find-webclient.html" }
    private val loader = WebViewAssetLoader.Builder().addPathHandler("/assets/",WebViewAssetLoader.AssetsPathHandler(activity)).build()
    private var script: ScriptHandler? = null
    private var configured = ""
    private data class Selection(val target: String, val previousAddress: String, val previousMode: String, val history: String, var started: Boolean = false, var mainUrl: String = target)
    private var selection: Selection? = null
    private var selectionError = false
    init {
        require(WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) { "请更新 Android System WebView 后重试" }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        view.setBackgroundColor(android.graphics.Color.rgb(16,16,16))
        with(view.settings) { javaScriptEnabled = true; domStorageEnabled = true; mediaPlaybackRequiresUserGesture = false; allowFileAccess = false; allowContentAccess = true; mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE; setSupportMultipleWindows(false); userAgentString = WindowLayout.webUserAgent(userAgentString,BuildConfig.VERSION_NAME) }
        view.webViewClient = object: WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = loader.shouldInterceptRequest(request.url)
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if(!request.isForMainFrame) return false
                val address = request.url.toString()
                val origin = runCatching { ServerAddress.origin(address.substringBefore('?').substringBefore('#')) }.getOrNull() ?: return true
                val saved = settings.string("main","userWebClient")
                val allowed = origin == ASSET_ORIGIN || (saved.isNotBlank() && runCatching { ServerAddress.origin(saved) }.getOrNull() == origin)
                if(allowed) {
                    selection?.let { if(origin != ASSET_ORIGIN) it.mainUrl = address }
                    // A document-start script registered during this callback misses the already
                    // starting navigation. Restart it after registration when switching servers.
                    // The asset origin is already in the allowlist. Keep the
                    // current server registered so history Back/Cancel injects
                    // its bridge even when WebView skips this callback.
                    if(origin != ASSET_ORIGIN && configured != origin) { configure(origin); view.post { view.loadUrl(address) }; return true }
                    return false
                }
                if(request.url.scheme in listOf("http","https")) activity.openExternal(address)
                return true
            }
            override fun onPageStarted(view: WebView,url: String,favicon: Bitmap?) {
                selection?.let { if(url == it.target) it.started = true; if(!url.startsWith(ASSET_ORIGIN)) it.mainUrl = url }
                bridge.pageStarted(); activity.loading(true)
            }
            override fun onPageFinished(view: WebView,url: String) {
                selection?.let { pending ->
                    if(pending.started && url == view.url && runCatching { ServerAddress.origin(url.substringBefore('?').substringBefore('#')) == ServerAddress.origin(pending.target.substringBefore('?').substringBefore('#')) }.getOrDefault(false)) {
                        // Only a loaded server page becomes a remembered server.
                        if(pending.history.isNotEmpty()) runCatching { settings.set("main","knownServers",pending.history) }
                        selection = null; view.clearHistory()
                    }
                }
                DiagnosticsLog.app.record("info","WebView main document loaded"); activity.loading(false); activity.updateWindowMetrics()
            }
            override fun onReceivedError(view: WebView,request: WebResourceRequest,error: android.webkit.WebResourceError) { if(request.isForMainFrame) {
                DiagnosticsLog.app.record("error","WebView main document load failed code=${error.errorCode}")
                rollbackSelection(); activity.webError("网页加载失败（${error.errorCode}），请检查连接后重试")
            } }
            override fun onReceivedHttpError(view: WebView,request: WebResourceRequest,response: WebResourceResponse) {
                if(request.isForMainFrame) { rollbackSelection(); activity.webError("网页加载失败（HTTP ${response.statusCode}），请检查地址后重试") }
            }
            override fun onReceivedSslError(view: WebView,handler: android.webkit.SslErrorHandler,error: android.net.http.SslError) {
                handler.cancel()
                val mainUrl = selection?.mainUrl ?: view.url
                if(error.url.substringBefore('#') == mainUrl?.substringBefore('#')) { rollbackSelection(); activity.webError("服务器证书无效，请检查地址后重试") }
            }
        }
        view.webChromeClient = object: WebChromeClient() {
            override fun onJsPrompt(view: WebView, url: String, message: String, defaultValue: String?, result: android.webkit.JsPromptResult): Boolean {
                if(message != "Tigerest.ServerAddress") return super.onJsPrompt(view,url,message,defaultValue,result)
                if(url.substringBefore('?').substringBefore('#') != ONBOARDING) { result.cancel(); return true }
                activity.editServerAddress(defaultValue.orEmpty()) { value -> if(value == null) result.cancel() else result.confirm(value) }
                return true
            }
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                if(BuildConfig.DEBUG && message.message().startsWith("TGS phase ")) android.util.Log.i("TigerestWeb",message.message())
                // Server scripts can include authenticated URLs in errors. Keep diagnostics structural.
                if(BuildConfig.DEBUG && message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) android.util.Log.e("TigerestWeb","Web script error at line ${message.lineNumber()}")
                if(message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) DiagnosticsLog.app.record("error","WebView script error at line ${message.lineNumber()}")
                return true
            }
            override fun onShowFileChooser(webView: WebView,callback: android.webkit.ValueCallback<Array<android.net.Uri>>,params: FileChooserParams): Boolean { activity.chooseWebFile(callback,params.createIntent()); return true }
        }
    }
    private fun configure(origin: String) {
        if(configured == origin) return
        script?.remove(); if(configured.isNotEmpty()) WebViewCompat.removeWebMessageListener(view,"tigerestNative")
        val allowed = setOf(ASSET_ORIGIN,origin)
        WebViewCompat.addWebMessageListener(view,"tigerestNative",allowed) { _,message,source,isMain,reply ->
            if(isMain && source.toString().trimEnd('/') in allowed) message.data?.let { bridge.request(it,reply) }
        }
        val bootstrap = JSONObject().put("version",BuildConfig.VERSION_NAME).put("deviceName","${android.os.Build.MODEL} / Android").put("mode","desktop").put("userAgent",view.settings.userAgentString).put("scriptPath","$ASSET_ORIGIN/assets/shared").put("mpvConfigMode","embedded").put("mpvConfigDir","安卓应用内配置").put("settings",settings.values).put("sections",settings.sections).put("settingsDescriptions",settings.descriptions)
        val nativeFiles = listOf("serverKind.js","mpvVideoPlayer.js","mpvAudioPlayer.js","inputPlugin.js","sessionNavigationPlugin.js","communityClient.js","communityBridge.js","communitySession.js","communityAvatar.js","communityPublicClient.js","communityAccount.js","communityMessages.js","communityPlugin.js","watchTogetherClient.js","watchTogetherSync.js","watchTogether.js","jellyfinPlugin.js","connectivityHelper.js","serverHistory.js","nativeshell.js","offline.js","homeData.js","homeGallery.js","homeBackdrop.js","homeTransitions.js","homeMotion.js","embycompat.js","webAppearance.js","ambientBackdrop.js","updatePlugin.js")
        val injected = StringBuilder("(()=>{if(window!==window.top)return;\nwindow.__tigerestBootstrap=${bootstrap};\n").append(asset("androidBridge.js"))
        for(file in nativeFiles) {
            if(BuildConfig.DEBUG) injected.append("\nconsole.info('TGS phase start $file');")
            injected.append("\n;(function(){\n").append(asset("shared/$file")).append("\n}).call(window);\n")
            if(BuildConfig.DEBUG) injected.append("\nconsole.info('TGS phase done $file');")
        }
        injected.append("\ndocument.addEventListener('DOMContentLoaded',()=>{const style=document.createElement('style');style.textContent=").append(JSONObject.quote(asset("androidResponsive.css"))).append(";document.head.appendChild(style);});")
        injected.append("\n").append(asset("androidResponsive.js"))
        injected.append("\n})();")
        script = WebViewCompat.addDocumentStartJavaScript(view,injected.toString(),allowed)
        configured = origin
    }
    private fun asset(path: String) = activity.assets.open(path).bufferedReader().use { it.readText() }
    fun open(url: String) { val origin = if(url.startsWith(ASSET_ORIGIN)) ASSET_ORIGIN else ServerAddress.origin(url.substringBefore('?').substringBefore('#')); configure(origin); view.loadUrl(url) }
    fun openSaved() { val saved = settings.string("main","userWebClient"); open(saved.ifBlank { ONBOARDING }) }
    fun finishServerSelection(server: String, mode: String, target: String, history: String = ""): Boolean {
        if(selection != null || view.url?.substringBefore('?')?.substringBefore('#') != ONBOARDING) return false
        require(mode in setOf("custom","tigerest"))
        val origin = ServerAddress.origin(server)
        require(origin == ServerAddress.origin(target))
        if(history.isNotEmpty()) SettingsPolicy.validate("main","knownServers",history,"")
        selection = Selection(target,settings.string("main","userWebClient"),settings.string("main","serverConnectionMode"),history)
        settings.set("main","userWebClient",server); settings.set("main","serverConnectionMode",mode)
        configure(origin); view.loadUrl(target)
        return true
    }
    fun rollbackSelection(failed: Boolean = true): Boolean {
        val pending = selection ?: return false
        selection = null
        selectionError = failed
        settings.set("main","userWebClient",pending.previousAddress); settings.set("main","serverConnectionMode",pending.previousMode)
        configure(if(pending.previousAddress.isBlank()) ASSET_ORIGIN else ServerAddress.origin(pending.previousAddress))
        view.stopLoading()
        val history = view.copyBackForwardList()
        val chooser = (history.currentIndex downTo 0).firstOrNull { history.getItemAtIndex(it).url.startsWith(ONBOARDING) }
        view.post {
            if(chooser != null && chooser < history.currentIndex) view.goBackOrForward(chooser - history.currentIndex)
            else if(chooser == history.currentIndex) view.reload()
            else view.loadUrl("$ONBOARDING?choose=1")
        }
        return true
    }
    fun takeServerSelectionError(): Boolean = selectionError.also { selectionError = false }
    fun restore(state: android.os.Bundle) {
        val saved = settings.string("main","userWebClient")
        configure(if(saved.isBlank()) ASSET_ORIGIN else ServerAddress.origin(saved))
        if(view.restoreState(state) == null) openSaved()
    }
    fun applySettings() { view.settings.setSupportZoom(settings.bool("main","allowBrowserZoom")); view.settings.builtInZoomControls = settings.bool("main","allowBrowserZoom"); view.settings.displayZoomControls = false }
    fun close() { script?.remove(); view.destroy() }
}
