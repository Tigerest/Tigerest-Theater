package top.tigerest.theater

import java.net.URI

object ServerAddress {
    fun base(input: String): String {
        val text = input.trim()
        require(text.isNotEmpty()) { "请填写服务器地址" }
        val uri = try { URI(if (text.contains("://")) text else "http://$text") } catch (_: Exception) { throw IllegalArgumentException("服务器地址格式错误") }
        val scheme = uri.scheme?.lowercase()
        require(scheme in listOf("http", "https") && !uri.host.isNullOrEmpty() && uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null) { "请使用不含账号、密码和查询参数的 HTTP(S) 地址" }
        require(uri.port in -1..65535 && uri.port != 0) { "端口无效" }
        val path = (uri.rawPath ?: "").replace(Regex("/web(?:/index\\.html)?/?$"), "").trimEnd('/') + "/"
        val port = if(uri.port == -1 || scheme == "https" && uri.port == 443 || scheme == "http" && uri.port == 80) "" else ":${uri.port}"
        return URI("$scheme://${uri.host.lowercase()}$port$path").toASCIIString()
    }
    fun origin(input: String): String {
        val uri = URI(base(input))
        return "${uri.scheme}://${uri.rawAuthority}"
    }
    /** The dedicated server's public address is HTTPS from 2.9.5; a profile saved on the old one moves to it. */
    fun movedDedicated(saved: String, mode: String): String? =
        if (mode != "custom" && runCatching { origin(saved) }.getOrNull() == "http://nas.tigerest.top:8095") "https://nas.tigerest.top:18445/" else null
}
