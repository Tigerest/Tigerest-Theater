package top.tigerest.theater

/** Self-reported build details the comment, room and danmaku services record.
 *  They name the build, never a device or a person. */
object ClientIdentity {
    fun headers(version: String = BuildConfig.VERSION_NAME): Map<String,String> = mapOf(
        "X-Tigerest-Client-Name" to "Tigerest Theater",
        "X-Tigerest-Client-Version" to clean(version,40),
        "X-Tigerest-Client-Platform" to "Android").filterValues { it.isNotEmpty() }
    internal fun clean(value: String, limit: Int) = value.filter { it.code in 0x20..0x7e }.trim().take(limit)
}
