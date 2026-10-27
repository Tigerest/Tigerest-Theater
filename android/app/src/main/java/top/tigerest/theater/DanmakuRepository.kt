package top.tigerest.theater

import android.content.Context
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.io.File
import java.security.MessageDigest

data class DanmakuSource(val id: String, val title: String, val comments: List<DanmakuComment>, var enabled: Boolean = true, var delay: Double = 0.0, val policyId: String = id)
class DanmakuRepository(private val context: Context,private val settings: SettingsStore) {
    private val client = OkHttpClient.Builder().connectTimeout(8,TimeUnit.SECONDS).readTimeout(20,TimeUnit.SECONDS).build()
    private val mappingClient = OkHttpClient.Builder().connectTimeout(5,TimeUnit.SECONDS)
        .readTimeout(35,TimeUnit.SECONDS).callTimeout(35,TimeUnit.SECONDS)
        .followRedirects(false).followSslRedirects(false).build()
    private val privateConfiguration = PrivateDanmakuConfiguration(context)
    @Volatile private var mappingAuthorization=MappingAuthorization()
    private val sharedMapping = SharedDanmakuMapping(::mappingRequest,{mappingAuthorization.legacyCredential(privateConfiguration::credential)},sessionHeaders={mappingAuthorization.headers.takeIf{it.isNotEmpty()}})
    private val executor = Executors.newSingleThreadExecutor()
    private val prefs = context.getSharedPreferences("danmaku-sources",Context.MODE_PRIVATE)
    private val requestGeneration = DanmakuRequestGeneration()
    private val generation get() = requestGeneration.currentToken()
    @Volatile var sources: List<DanmakuSource> = emptyList(); private set
    var changed: () -> Unit = {}
    var status: (String) -> Unit = {}
    private var group = ""
    private var itemKey = ""
    private val cache = File(context.filesDir,"danmaku-history").apply { mkdirs() }
    private var item = JSONObject()
    private fun base(): String = settings.string("danmaku","apiServer").takeIf { it.isNotBlank() }?.let { ServerAddress.base(it).trimEnd('/') } ?: if(settings.string("main","userWebClient").contains("192.168.5.150")) SharedDanmakuMapping.LAN_ORIGIN else SharedDanmakuMapping.REMOTE_ORIGIN
    private fun fetch(path: String,origin: String = base()): JSONObject {
        val wait=sharedMapping.retryAfter(origin);check(wait==0L){"弹幕接口请求过于频繁，请 $wait 秒后重试"}
        val url = origin+path
        val request = Request.Builder().url(url).header("Accept","application/json").header("User-Agent","TigerestTheater Android")
        // Our own service records which client asked; other providers receive nothing.
        if(SharedDanmakuMapping.trustedOrigin(origin) != null) ClientIdentity.headers().forEach{(name,value)->request.header(name,value)}
        client.newCall(request.build()).execute().use { response ->
            require(response.isSuccessful) { "弹幕服务暂不可用（${response.code}）" }
            val body = response.body ?: throw IllegalStateException("弹幕响应为空")
            require(body.contentLength() < 32*1024*1024) { "弹幕文件过大" }
            val bytes = body.byteStream().use { it.readNBytes(16*1024*1024+1) }; require(bytes.size <= 16*1024*1024) { "弹幕文件过大" }; val text = bytes.toString(Charsets.UTF_8)
            return JSONObject(text)
        }
    }
    private fun mappingRequest(url: String,body: String,credential: Map<String,String>?): MappingHttpResponse {
        val request = Request.Builder().url(url).header("Accept","application/json")
            .header("User-Agent","TigerestTheater Android")
            .post(body.toRequestBody("application/json; charset=utf-8".toMediaType()))
        // Shared mappings are only ever asked of our own service.
        ClientIdentity.headers().forEach{(name,value)->request.header(name,value)}
        credential?.forEach{(name,value)->request.header(name,value)}
        mappingClient.newCall(request.build()).execute().use { response ->
            if(response.code != 200) return MappingHttpResponse(response.code,"",response.header("Retry-After"))
            val data = response.body
            val bytes = if(data == null) ByteArray(0) else {
                require(data.contentLength() <= SharedDanmakuMapping.MAX_RESPONSE_BYTES) { "弹幕文件过大" }
                data.byteStream().use { it.readNBytes(SharedDanmakuMapping.MAX_RESPONSE_BYTES+1) }
            }
            require(bytes.size <= SharedDanmakuMapping.MAX_RESPONSE_BYTES) { "弹幕文件过大" }
            return MappingHttpResponse(response.code,bytes.toString(Charsets.UTF_8),response.header("Retry-After"))
        }
    }
    @Synchronized fun autoMatch(metadata: JSONObject) {
        val token = requestGeneration.playbackChanged(); item = JSONObject(metadata.toString())
        val original = JSONObject(item.toString())
        mappingClient.dispatcher.cancelAll(); client.dispatcher.cancelAll()
        group = metadata.optString("SeriesName",metadata.optString("Name"))+":"+metadata.optInt("ParentIndexNumber",-1)
        itemKey = metadata.optString("Id").ifBlank { metadata.optString("Name")+":"+metadata.optInt("IndexNumber",-1) }
        val historyKey = itemKey
        sources = emptyList(); changed()
        if(!settings.bool("mpv","enableDanmaku")) return
        executor.execute {
            try {
                if(token != generation) return@execute
                // Always consult the gateway before loading a cached/local inference.
                val origin = base()
                val mapping = sharedMapping.lookup(origin,original,token,::isCurrent)
                if(mapping.kind == MappingResult.Kind.STALE || token != generation) {
                    DiagnosticsLog.app.record("info","Danmaku discarded stale lookup response")
                    return@execute
                }
                if(mapping.kind == MappingResult.Kind.HIT) {
                    loadMapping(mapping,origin,token)
                    return@execute
                }
                if(mapping.kind==MappingResult.Kind.RATE_LIMITED){status("弹幕接口请求过于频繁，请 ${sharedMapping.retryAfter(origin)} 秒后重试");return@execute}
                DiagnosticsLog.app.record("info","Danmaku shared lookup used legacy fallback (${mapping.kind.name.lowercase()})")
                val history = runCatching { JSONArray(prefs.getString("history:$historyKey","[]")) }.getOrDefault(JSONArray())
                for(index in 0 until minOf(history.length(),12)) {
                    if(token != generation) return@execute
                    val record = history.getJSONObject(index)
                    val file = File(cache,cacheName(historyKey,record.getString("id")))
                    if(file.exists() && file.length() <= 16*1024*1024) runCatching { add(record.getString("id"),record.getString("title"),DanmakuParser.parse(file.readText()),token,false,record.optString("policy",record.getString("id"))) }
                }
                if(token != generation || sources.isNotEmpty()) return@execute
                val title = original.optString("SeriesName",original.optString("Name"))
                if(title.isBlank()) return@execute
                val animes = search(title)
                if(token != generation) return@execute
                val savedBangumi = prefs.getString("match:$group",null)
                val selected = DanmakuMatch.resolve((0 until animes.length()).mapNotNull { animes.optJSONObject(it) },
                    title,original.optInt("ParentIndexNumber",-1),original.optInt("IndexNumber",-1),
                    original.optString("Name"),savedBangumi,{token==generation}) { anime ->
                    val records=episodes(anime.get("bangumiId").toString(),origin)
                    (0 until records.length()).mapNotNull { records.optJSONObject(it) }
                }
                if(selected == null) { if(token == generation) status("弹幕未自动匹配，请手动搜索作品或选择集数"); return@execute }
                if(token == generation) {
                    DiagnosticsLog.app.record("info","Danmaku selected regular episode (matchedByTitle=${selected.matchedByTitle})")
                    val label=selected.anime.optString("animeTitle",title)+" - "+selected.episode.optString("episodeTitle",title)
                    loadLegacy(selected.episode.get("episodeId").toString(),label,token,origin)
                }
            } catch(_: Exception) { if(token == generation) status("弹幕暂不可用，可以稍后手动搜索") }
        }
    }
    fun search(keyword: String): JSONArray { require(keyword.isNotBlank() && keyword.length <= 200); return fetch("/api/v2/search/anime?keyword="+URLEncoder.encode(keyword,"UTF-8")).optJSONArray("animes") ?: JSONArray() }
    fun episodes(id: String,origin: String = base()): JSONArray { require(id.length <= 100 && id.matches(Regex("(?:[0-9]+|tmdb-[A-Za-z0-9-]+)"))); val bangumi = fetch("/api/v2/bangumi/$id",origin).optJSONObject("bangumi") ?: JSONObject(); return bangumi.optJSONArray("episodes") ?: JSONArray() }
    private fun cacheName(item: String,id: String) = MessageDigest.getInstance("SHA-256").digest((item+":"+id).toByteArray()).joinToString("") { "%02x".format(it) }+".json"
    @Synchronized private fun add(id: String,title: String,comments: List<DanmakuComment>,token: Long,remember: Boolean = true,policyId: String = id) {
        if(token != generation) return
        require(sources.size < 12 || sources.any { it.id == id }) { "最多添加 12 个弹幕来源" }
        val source = DanmakuSource(id,title,comments,prefs.getBoolean("enabled:$group:$policyId",true),prefs.getString("delay:$group:$policyId","0")?.toDoubleOrNull() ?: 0.0,policyId)
        sources = sources.filter { it.id != id }+source
        if(remember) {
            val json = JSONArray(); comments.forEach { json.put(JSONObject().put("p","${it.time},${it.mode},${it.color}").put("m",it.text)) }
            val text = JSONObject().put("comments",json).toString()
            if(text.toByteArray().size <= 16*1024*1024) File(cache,cacheName(itemKey,id)).writeText(text)
            val history = JSONArray(); sources.forEach { history.put(JSONObject().put("id",it.id).put("title",it.title).put("policy",it.policyId)) }
            prefs.edit().putString("history:$itemKey",history.toString()).apply()
            // Limit local history storage; preference entries without files are harmless.
            val files = cache.listFiles()?.sortedBy { it.lastModified() } ?: emptyList(); var total = files.sumOf { it.length() }
            for(file in files) { if(total <= 128L*1024*1024) break; total -= file.length(); file.delete() }
        }
        changed(); status("${title}\n已加载 ${comments.size} 条弹幕\n匹配不正确可在弹幕菜单中手动纠正")
    }
    fun load(id: String,title: String = "弹幕",token: Long = generation): Int {
        if(token != generation) return 0
        require(id.matches(Regex("[0-9]+")))
        val origin = base()
        return loadLegacy(id,title,token,origin)
    }
    private fun loadLegacy(id: String,title: String,token: Long,origin: String): Int {
        if(token != generation) return 0
        val json = fetch("/api/v2/comment/$id?withRelated=true&chConvert=0",origin)
        if(token != generation) return 0
        val comments = DanmakuParser.parse(json.toString()); add(id,title,comments,token,policyId="dandanplay:"+origin); return comments.size
    }
    private fun loadMapping(result: MappingResult,origin: String,token: Long): Int {
        if(token != generation) return 0
        val match = result.match ?: return 0
        val comments = DanmakuParser.parse(result.danmaku!!.toString())
        val label=listOf(match.optString("animeTitle"),match.optString("episodeTitle","弹幕")).filter { it.isNotBlank() }.joinToString(" - ")
        add(match.get("episodeId").toString(),label,comments,token,policyId="dandanplay:"+origin)
        if(token == generation) {
            val shared = match.optString("origin") == "shared"
            DiagnosticsLog.app.record("info",if(shared) "Danmaku shared mapping loaded" else "Danmaku manual mapping saved and loaded")
            if(shared) status("${label}\n来自共享匹配 · 已加载 ${comments.size} 条弹幕\n可在弹幕菜单中手动纠正")
        }
        return comments.size
    }
    fun selectEpisode(bangumiId: String,episodeId: String,title: String,token: Long): Int {
        require(episodeId.matches(Regex("[0-9]{1,32}")))
        val (selectionToken, original) = synchronized(this) {
            val next = requestGeneration.manualSelection(token) ?: return 0
            // A choice supersedes pending automatic lookup, legacy inference and
            // previous selection responses even when the playback item is unchanged.
            mappingClient.dispatcher.cancelAll(); client.dispatcher.cancelAll()
            next to JSONObject(item.toString())
        }
        val origin = base()
        val result = sharedMapping.select(origin,original,bangumiId,episodeId,selectionToken,::isCurrent)
        if(result.kind == MappingResult.Kind.STALE || selectionToken != generation) {
            DiagnosticsLog.app.record("info","Danmaku discarded stale manual response")
            return 0
        }
        if(result.kind == MappingResult.Kind.HIT) {
            rememberMatch(bangumiId,selectionToken)
            return loadMapping(result,origin,selectionToken)
        }
        if(result.kind==MappingResult.Kind.RATE_LIMITED){status("弹幕接口请求过于频繁，请 ${sharedMapping.retryAfter(origin)} 秒后重试");return 0}
        val count = loadLegacy(episodeId,title,selectionToken,origin)
        if(selectionToken == generation) {
            rememberMatch(bangumiId,selectionToken)
            if(result.kind == MappingResult.Kind.FAILED||result.kind == MappingResult.Kind.SKIPPED) {
                DiagnosticsLog.app.record("warning","Danmaku manual mapping save failed; selected legacy comments loaded")
                status("弹幕已加载，但共享匹配未保存")
            }
        }
        return count
    }
    fun configureMappingCredential(value: String) = privateConfiguration.setCredential(value)
    @Synchronized fun setMappingSession(headers:Map<String,String>,legacyEligible:Boolean=false){
        requestGeneration.playbackChanged();mappingAuthorization=MappingAuthorization(headers.toMap(),legacyEligible)
        mappingClient.dispatcher.cancelAll();client.dispatcher.cancelAll()
    }
    fun importText(id: String,title: String,text: String,token: Long = generation) { add(id,title,DanmakuParser.parse(text),token) }
    fun sourceSnapshot(): JSONArray = JSONArray().also { result -> sources.forEach { result.put(JSONObject().put("id",it.id).put("title",it.title).put("enabled",it.enabled).put("delay",it.delay).put("count",it.comments.size)) } }
    @Synchronized fun sourceSetting(id: String,enabled: Boolean,delay: Double) { require(delay.isFinite() && delay in -3600.0..3600.0); val source = sources.find { it.id == id } ?: throw IllegalArgumentException("弹幕来源不存在"); source.enabled = enabled; source.delay = delay; prefs.edit().putBoolean("enabled:$group:${source.policyId}",enabled).putString("delay:$group:${source.policyId}",delay.toString()).apply(); changed() }
    @Synchronized fun rememberMatch(bangumi: String,token: Long = generation) { if(token == generation) prefs.edit().putString("match:$group",bangumi).apply() }
    fun currentToken() = generation
    fun isCurrent(token: Long) = generation == token
    fun dispatch(method: String,args: JSONArray): Any? = when(method) {
        "search" -> search(args.getString(0))
        "episodes" -> episodes(args.get(0).toString())
        "match" -> { autoMatch(args.getJSONObject(0)); true }
        "load" -> load(args.get(0).toString(),args.optString(1,"弹幕"))
        "sources" -> sourceSnapshot()
        "setSource" -> { sourceSetting(args.getString(0),args.getBoolean(1),args.getDouble(2)); true }
        "setEnabled" -> settings.set("mpv","enableDanmaku",args.getBoolean(0))
        "loadUrl" -> loadUrl(args.getString(0))
        else -> throw IllegalArgumentException("弹幕操作无效")
    }
    fun loadUrl(url: String): Int {
        val uri = java.net.URI(url); require(uri.scheme in listOf("http","https") && uri.host != null && uri.userInfo == null && url.length < 4096) { "弹幕来源网址无效" }
        val token = generation; val comments = DanmakuParser.parse(fetch("/api/v2/extcomment?url="+URLEncoder.encode(url,"UTF-8")).toString())
        add(url,uri.host,comments,token); return comments.size
    }
    @Synchronized fun clear() { requestGeneration.playbackChanged(); mappingClient.dispatcher.cancelAll(); sources = emptyList(); changed() }
    fun close() { clear(); executor.shutdownNow(); client.dispatcher.cancelAll() }
}
