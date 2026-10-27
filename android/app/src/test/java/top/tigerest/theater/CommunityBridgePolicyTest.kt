package top.tigerest.theater
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
class CommunityBridgePolicyTest {
 @Test fun sourceAvatarUsesOnlySuppliedOwnOriginAndConfirmedIdentity(){
  val session=JSONObject().put("address","https://own.example:8096/emby/").put("userId","0123456789abcdef0123456789abcdef").put("token","own-token")
  assertEquals("https://own.example:8096/emby/Users/0123456789abcdef0123456789abcdef",CommunityBridgePolicy.sourceUrl(session,false)?.toString())
  assertEquals("https://own.example:8096/emby/Users/0123456789abcdef0123456789abcdef/Images/Primary?MaxWidth=128&MaxHeight=128&Format=png",CommunityBridgePolicy.sourceUrl(session,true)?.toString())
  for(address in listOf("file:///private","http://user:secret@own.example","http://own.example?token=secret","http://own.example/#fragment","http://nas.tigerest.top:18443/community/v2","https://nas.tigerest.top:18446/community/v2","http://own.example/../other","http://own.example/%2e%2e/other"))assertNull(CommunityBridgePolicy.sourceUrl(JSONObject(session.toString()).put("address",address),false))
  val metadata=JSONObject().put("Id",session.getString("userId")).put("PrimaryImageTag","tag")
  assertEquals("present",CommunityBridgePolicy.avatarState(metadata,session.getString("userId")))
  for(absent in listOf(JSONObject.NULL,"")){metadata.put("PrimaryImageTag",absent);assertEquals("absent",CommunityBridgePolicy.avatarState(metadata,session.getString("userId")))}
  metadata.remove("PrimaryImageTag");assertEquals("absent",CommunityBridgePolicy.avatarState(metadata,session.getString("userId")))
  metadata.put("PrimaryImageTag",7);assertEquals("unknown",CommunityBridgePolicy.avatarState(metadata,session.getString("userId")))
  metadata.put("Id","different").put("PrimaryImageTag",JSONObject.NULL);assertEquals("unknown",CommunityBridgePolicy.avatarState(metadata,session.getString("userId")))
 }
 @Test fun imagesRequireExactAvatarRouteBearerAndSeparateBodyLimits(){
  val path="/avatars/2c9b6e0e-4af8-4fd6-bc92-144604e59389?v="+"a".repeat(64)
  val r=JSONObject().put("path",path).put("method","GET").put("responseType","image").put("headers",JSONObject().put("Authorization","Bearer fixture"))
  assertTrue(CommunityBridgePolicy.allowed(r,""))
  for(invalid in listOf("/me",path+"&token=secret","/avatars/invalid?v="+"a".repeat(64),path.uppercase()))assertFalse(CommunityBridgePolicy.allowed(JSONObject(r.toString()).put("path",invalid),""))
  assertFalse(CommunityBridgePolicy.allowed(JSONObject(r.toString()).put("headers",JSONObject()),""))
  assertFalse(CommunityBridgePolicy.allowed(JSONObject(r.toString()).put("method","POST"),""))
  assertFalse(CommunityBridgePolicy.allowed(JSONObject(r.toString()).put("responseType","arbitrary"),""))
  r.remove("responseType");r.put("path","/me/avatar").put("method","PUT").put("body","x".repeat(393216));assertTrue(CommunityBridgePolicy.allowed(r,""))
  r.put("body","x".repeat(393217));assertFalse(CommunityBridgePolicy.allowed(r,""))
  r.put("body","x".repeat(16385)).put("method","POST");assertFalse(CommunityBridgePolicy.allowed(r,""))
  r.put("method","PUT").put("path","/me/password");assertFalse(CommunityBridgePolicy.allowed(r,""))
 }
 @Test fun legacyMappingNeedsExplicitModeTrustedIdentityAndOnlyCapability404(){
  val trusted="62526c3bf747439c99327ddec5fed4a8"
  val session=JSONObject().put("serverId","62526C3B-F747-439C-9932-7DDEC5FED4A8").put("token","fixture-token").put("userId","fixture-user").put("mappingAuth","legacy")
  for(code in listOf(0,200,401,403,503)){
   val auth=CommunityBridgePolicy.mappingAuthorization(session,trusted,code)
   assertFalse("Capability $code must not grant a legacy authorization",auth.available)
  }
  val legacy=CommunityBridgePolicy.mappingAuthorization(session,trusted,404)
  assertTrue(legacy.legacyEligible);assertTrue(legacy.headers.isEmpty())
  assertFalse(CommunityBridgePolicy.mappingAuthorization(session,"",404).available)
  assertFalse(CommunityBridgePolicy.mappingAuthorization(session,"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",404).available)
  assertFalse(CommunityBridgePolicy.mappingAuthorization(session,trusted,404,"fixture-token").available)
  session.remove("mappingAuth")
  val ordinary=CommunityBridgePolicy.mappingAuthorization(session,trusted,200)
  assertFalse(ordinary.legacyEligible)
  assertEquals(setOf("X-Emby-Token","X-Emby-Server-Id","X-Emby-User-Id"),ordinary.headers.keys)
 }
 @Test fun originsAndHeadersStaySeparated(){
  val r=JSONObject().put("path","/me").put("method","GET").put("headers",JSONObject().put("Authorization","Bearer fixture"))
  assertTrue(CommunityBridgePolicy.allowed(r,""))
  for(path in listOf("//evil.invalid","/../me","http://evil.invalid/me","/me#token"))assertFalse(CommunityBridgePolicy.allowed(JSONObject(r.toString()).put("path",path),""))
  r.put("headers",JSONObject().put("X-Emby-Token","private"));assertFalse(CommunityBridgePolicy.allowed(r,""))
  val trusted="62526c3bf747439c99327ddec5fed4a8"
  r.put("path","/auth/emby").put("method","POST").put("body","{}").put("headers",JSONObject().put("X-Emby-Token","fixture").put("X-Emby-User-Id","user").put("X-Emby-Server-Id","62526C3B-F747-439C-9932-7DDEC5FED4A8"))
  assertTrue(CommunityBridgePolicy.allowed(r,trusted));assertFalse(CommunityBridgePolicy.allowed(r,""))
 }
}
