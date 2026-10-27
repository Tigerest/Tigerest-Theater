package top.tigerest.theater
import org.junit.Assert.*
import org.junit.Test
class ClientIdentityTest {
 @Test fun reportsThisBuildAsPrintableAscii(){
  assertEquals(mapOf("X-Tigerest-Client-Name" to "Tigerest Theater","X-Tigerest-Client-Version" to BuildConfig.VERSION_NAME,"X-Tigerest-Client-Platform" to "Android"),ClientIdentity.headers())
  assertEquals("2.9.5",ClientIdentity.headers(" 2.9.5\u0007\r\n版 ")["X-Tigerest-Client-Version"])
  assertEquals(40,ClientIdentity.headers("9".repeat(80))["X-Tigerest-Client-Version"]?.length)
  assertFalse(ClientIdentity.headers("\u0007").containsKey("X-Tigerest-Client-Version"))
 }
}
