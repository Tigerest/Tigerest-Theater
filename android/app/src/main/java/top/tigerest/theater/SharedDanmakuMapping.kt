package top.tigerest.theater

import org.json.JSONObject
import java.net.URI
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.concurrent.ConcurrentHashMap

data class MappingHttpResponse(val code: Int, val body: String, val retryAfter: String? = null)
data class MappingResult(val kind: Kind, val match: JSONObject? = null, val danmaku: JSONObject? = null) {
    enum class Kind { HIT, FAILED, SKIPPED, STALE, RATE_LIMITED }
}

/** Transport is injected so protocol, generation and cooldown behavior runs on the JVM. */
class SharedDanmakuMapping(
    private val transport: (String, String, Map<String,String>?) -> MappingHttpResponse,
    private val credential: () -> String?,
    private val elapsedMillis: () -> Long = { System.nanoTime() / 1_000_000 },
    private val wallMillis: () -> Long = { System.currentTimeMillis() },
    private val sessionHeaders: () -> Map<String,String>? = { null }
) {
    private val cooldown = ConcurrentHashMap<String, Long>()
    fun retryAfter(origin:String):Long {
        if(trustedOrigin(origin)==null)return 0
        val until=cooldown["nas"]?:return 0
        return if(until<=elapsedMillis())0 else (until-elapsedMillis())/1000+1
    }

    fun lookup(origin: String, metadata: JSONObject, generation: Long, isCurrent: (Long) -> Boolean): MappingResult =
        request(origin, metadata, null, generation, isCurrent)

    fun select(origin: String, metadata: JSONObject, bangumiId: String, episodeId: String,
               generation: Long, isCurrent: (Long) -> Boolean): MappingResult {
        if (!isCurrent(generation)) return MappingResult(MappingResult.Kind.STALE)
        if (!bangumiId.matches(Regex("(?:[0-9]+|tmdb-[A-Za-z0-9-]+)")) || bangumiId.length > 100 ||
            !episodeId.matches(Regex("[0-9]{1,32}"))) return MappingResult(MappingResult.Kind.SKIPPED)
        return request(origin, metadata, JSONObject().put("bangumiId",bangumiId).put("episodeId",episodeId), generation, isCurrent)
    }

    private fun request(origin: String, metadata: JSONObject, selection: JSONObject?, generation: Long,
                        isCurrent: (Long) -> Boolean): MappingResult {
        if (!isCurrent(generation)) return MappingResult(MappingResult.Kind.STALE)
        val normalized = trustedOrigin(origin) ?: return MappingResult(MappingResult.Kind.SKIPPED)
        val source = source(metadata) ?: return MappingResult(MappingResult.Kind.SKIPPED)
        var auth:Map<String,String>? = null
        if(selection!=null){
            auth=sessionHeaders()?.takeIf { it.keys==setOf("X-Emby-Token","X-Emby-Server-Id","X-Emby-User-Id")&&it.values.all(CommunityBridgePolicy::safe) }
                ?: credential()?.takeIf { validCredential(it) }?.let{mapOf("Authorization" to "Bearer $it")}
            if(auth==null)return MappingResult(MappingResult.Kind.SKIPPED)
        }
        if (retryAfter(normalized)>0) return MappingResult(MappingResult.Kind.RATE_LIMITED)
        val request = JSONObject().put("source",source).put("comment",JSONObject().put("withRelated",true).put("chConvert",0))
        if (selection != null) request.put("selection",selection)
        val body = request.toString()
        if (body.toByteArray(Charsets.UTF_8).size > 16384) return MappingResult(MappingResult.Kind.SKIPPED)
        if (!isCurrent(generation)) return MappingResult(MappingResult.Kind.STALE)
        val response = try { transport(normalized + "/api/tigerest/v1/danmaku", body, auth) }
            catch (_: Exception) { return MappingResult(if (isCurrent(generation)) MappingResult.Kind.FAILED else MappingResult.Kind.STALE) }
        // Rate limiting is shared by all playback items; stale responses still set it.
        if (response.code == 429) {
            val delay = retryAfterMillis(response.retryAfter, wallMillis())
            val now = elapsedMillis()
            val until=if (now > Long.MAX_VALUE - delay) Long.MAX_VALUE else now + delay
            cooldown["nas"]=maxOf(cooldown["nas"]?:Long.MIN_VALUE,until)
        }
        if (!isCurrent(generation)) return MappingResult(MappingResult.Kind.STALE)
        if(response.code==429)return MappingResult(MappingResult.Kind.RATE_LIMITED)
        if (response.code != 200 || response.body.toByteArray(Charsets.UTF_8).size > MAX_RESPONSE_BYTES) return MappingResult(MappingResult.Kind.FAILED)
        val data = runCatching { JSONObject(response.body) }.getOrNull() ?: return MappingResult(MappingResult.Kind.FAILED)
        val match = data.optJSONObject("match")
        val comments = data.optJSONObject("danmaku")
        if (data.opt("success") != true || data.opt("matched") != true || match == null || comments?.optJSONArray("comments") == null ||
            !match.optString("episodeId").matches(Regex("[0-9]{1,32}")) ||
            match.optString("origin") != (if (selection == null) "shared" else "manual")) return MappingResult(MappingResult.Kind.FAILED)
        return MappingResult(MappingResult.Kind.HIT,match,comments)
    }

    companion object {
        const val MAX_RESPONSE_BYTES = 16 * 1024 * 1024
        fun validCredential(value: String): Boolean = value.length in 1..4000 && value.matches(Regex("[A-Za-z0-9._~+/=-]+"))
        // Our service: plain HTTP inside the NAS network, HTTPS from anywhere else.
        const val LAN_ORIGIN = "http://192.168.5.150:18443"
        const val REMOTE_ORIGIN = "https://nas.tigerest.top:18446"
        fun trustedOrigin(value: String): String? = runCatching {
            val uri = URI(value)
            val origin = "${uri.scheme}://${uri.host}:${uri.port}"
            if (origin !in listOf(LAN_ORIGIN, REMOTE_ORIGIN) || uri.rawUserInfo != null || uri.rawQuery != null ||
                uri.rawFragment != null || uri.rawPath !in listOf("", "/")) null else origin
        }.getOrNull()

        fun source(metadata: JSONObject): JSONObject? {
            val title = metadata.opt("SeriesName") as? String ?: return null
            fun number(key: String, maximum: Int): Int? {
                val value = metadata.opt(key) ?: return null
                if (value !is Number && value !is String) return null
                val number = value.toString().toDoubleOrNull() ?: return null
                return if (number.isFinite() && number in 1.0..maximum.toDouble() && number == kotlin.math.floor(number)) number.toInt() else null
            }
            val season = number("ParentIndexNumber",1000) ?: return null
            val episode = number("IndexNumber",10000) ?: return null
            if (title.isBlank() || title.codePointCount(0,title.length) > 200) return null
            return JSONObject().put("title",title).put("season",season).put("episode",episode)
        }

        fun retryAfterMillis(value: String?, nowMillis: Long): Long {
            val digits = value?.trim()?.takeIf { it.matches(Regex("[0-9]+")) }
            if (digits != null) {
                val seconds = digits.toLongOrNull() ?: return Long.MAX_VALUE
                return if (seconds > Long.MAX_VALUE / 1000) Long.MAX_VALUE else seconds * 1000
            }
            return runCatching {
                val date = ZonedDateTime.parse(value,DateTimeFormatter.RFC_1123_DATE_TIME).toInstant().toEpochMilli()
                maxOf(0L,date-nowMillis)
            }.getOrDefault(60000L)
        }
    }
}
