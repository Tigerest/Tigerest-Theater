package top.tigerest.theater

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.Base64

/** The community server's signed copy of the GitHub release list (docs/backend-app-release-feed.md, same rules as src/system/ReleaseFeed.cpp). */
object ReleaseFeed {
    const val ADDRESS = "https://nas.tigerest.top:18446/api/tigerest/v1/app/releases"
    const val MAX_ENVELOPE = 2 * 1024 * 1024
    const val MAX_PAYLOAD = 1024 * 1024
    /** keyId → raw 32-byte Ed25519 public key (standard base64); a rotated key is added beside the old one. */
    val PRODUCTION_KEYS = mapOf("tg-release-1" to "zIJjQTCdN1PbiNIUyVNJmPZys/Pdar/YRvzKYd/knBA=")
    private const val CLOCK_SKEW_SECONDS = 10 * 60L
    private const val STALE_AFTER_SECONDS = 72 * 3600L
    private val TIMESTAMP = Regex("""\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z""")

    class Rejected(reason: String) : Exception(reason)

    /** The releases of an envelope signed by one of [keys] and current at [now]; [Rejected] with the reason otherwise. */
    fun open(envelope: ByteArray, now: Instant, keys: Map<String, String> = PRODUCTION_KEYS): JSONArray {
        if (envelope.size > MAX_ENVELOPE) throw Rejected("envelope over 2 MiB")
        val outer = runCatching { JSONObject(envelope.toString(Charsets.UTF_8)) }.getOrDefault(JSONObject())
        val publicKey = keys[outer.optString("keyId")]?.let { Base64.getDecoder().decode(it) } ?: throw Rejected("unknown keyId")
        val payload = strictBase64(outer.opt("payload"))
        val signature = strictBase64(outer.opt("signature"))
        if (payload == null || signature == null || payload.isEmpty() || signature.isEmpty()) throw Rejected("payload or signature missing or not base64")
        if (payload.size > MAX_PAYLOAD) throw Rejected("payload over 1 MiB")
        if (!Ed25519.verify(signature, payload, publicKey)) throw Rejected("bad signature")
        val feed = runCatching { JSONObject(payload.toString(Charsets.UTF_8)) }.getOrNull() ?: throw Rejected("payload is not an object")
        if (feed.opt("schema") != 1 || feed.opt("repository") != "Tigerest/Tigerest-Theater") throw Rejected("unexpected schema or repository")
        val issued = timestamp(feed.opt("issuedAt")); val fetched = timestamp(feed.opt("fetchedAt"))
        if (issued == null || fetched == null) throw Rejected("bad timestamps")
        if (fetched > issued) throw Rejected("fetchedAt after issuedAt")
        if (issued > now.plusSeconds(CLOCK_SKEW_SECONDS)) throw Rejected("issuedAt in the future")
        if (fetched < now.minusSeconds(STALE_AFTER_SECONDS)) throw Rejected("release list older than 72 hours")
        return feed.opt("releases") as? JSONArray ?: throw Rejected("releases missing")
    }

    private fun strictBase64(value: Any?): ByteArray? =
        (value as? String)?.let { runCatching { Base64.getDecoder().decode(it) }.getOrNull() }

    private fun timestamp(value: Any?): Instant? =
        (value as? String)?.takeIf { TIMESTAMP.matches(it) }?.let { runCatching { Instant.parse(it) }.getOrNull() }
}
