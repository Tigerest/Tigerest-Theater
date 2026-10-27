package top.tigerest.theater
import org.json.JSONObject
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.net.URI
data class MappingAuthorization(val headers:Map<String,String> = emptyMap(),val legacyEligible:Boolean = false) {
 val available get()=headers.isNotEmpty()||legacyEligible
 fun legacyCredential(load:()->String?):String?=if(legacyEligible)load()else null
}
object CommunityBridgePolicy {
 fun sourceUrl(session:JSONObject,image:Boolean):HttpUrl? {
  val address=session.optString("address");val user=session.optString("userId")
  val uri=runCatching{URI(address)}.getOrNull()?:return null
  val url=address.toHttpUrlOrNull()?:return null
  if(address.length>4096||uri.rawUserInfo!=null||uri.rawAuthority?.contains('@')==true||uri.rawQuery!=null||uri.rawFragment!=null||
   (url.host.equals("nas.tigerest.top",true)&&url.port in listOf(18443,18446))||!safe(session.optString("token"))||!user.matches(Regex("[A-Za-z0-9_-]{1,128}"))||
   uri.path.orEmpty().let{it.contains('\\')||it.contains("//")||it.split('/').any{part->part=="."||part==".."}})return null
  val builder=url.newBuilder().addPathSegment("Users").addPathSegment(user)
  if(image)builder.addPathSegment("Images").addPathSegment("Primary").addQueryParameter("MaxWidth","128").addQueryParameter("MaxHeight","128").addQueryParameter("Format","png")
  return builder.build()
 }
 fun avatarState(metadata:JSONObject,user:String):String {
  val returned=metadata.opt("Id") as? String?:return "unknown"
  if(returned.isEmpty()||(if(guid(user).isEmpty())returned!=user else guid(returned)!=guid(user)))return "unknown"
  val tag=metadata.opt("PrimaryImageTag")
  if(!metadata.has("PrimaryImageTag")||tag===JSONObject.NULL||tag=="")return "absent"
  return if(tag is String&&tag.isNotEmpty())"present" else "unknown"
 }
 fun guid(value:String)=value.replace("-","").lowercase().takeIf { it.matches(Regex("[a-f0-9]{32}")) } ?: ""
 fun safe(value:String)=value.isNotEmpty()&&value.length<=4000&&!value.contains(Regex("[\\x00-\\x20\\x7f]"))
 fun mappingAuthorization(session:JSONObject,trusted:String,capabilitiesStatus:Int,rejectedToken:String=""):MappingAuthorization {
  val valid=guid(trusted).isNotEmpty()&&guid(session.optString("serverId"))==guid(trusted)&&listOf("token","serverId","userId").all{safe(session.optString(it))}
  if(!valid)return MappingAuthorization()
  if(session.optString("mappingAuth")=="legacy")return MappingAuthorization(legacyEligible=capabilitiesStatus==404&&session.optString("token")!=rejectedToken)
  return MappingAuthorization(mapOf("X-Emby-Token" to session.getString("token"),"X-Emby-Server-Id" to session.getString("serverId"),"X-Emby-User-Id" to session.getString("userId")))
 }
 fun allowed(r:JSONObject,trusted:String):Boolean {
  val path=r.optString("path");val method=r.optString("method");val body=r.optString("body")
  val type=r.optString("responseType","json");val avatarUpload=path=="/me/avatar"&&method=="PUT"
  if(!path.matches(Regex("/[a-zA-Z0-9_/-]+(?:\\?[a-zA-Z0-9%_.~=&+/-]*)?"))||path.contains("//")||path.contains("..")||path.length>4096||method !in listOf("GET","POST","PUT","DELETE")||body.toByteArray().size>(if(avatarUpload)393216 else 16384)||(method in listOf("GET","DELETE")&&body.isNotEmpty()))return false
  val headers=r.optJSONObject("headers")?:JSONObject()
  if(type !in listOf("json","image"))return false
  if(type=="image"&&(method!="GET"||headers.length()!=1||!headers.has("Authorization")||!path.matches(Regex("/avatars/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\?v=[a-f0-9]{64}"))))return false
  if(avatarUpload&&(headers.length()!=1||!headers.has("Authorization")))return false
  if(path=="/mapping-capabilities")return method=="GET"&&headers.length()==0
  if(path=="/auth/emby"&&method=="POST")return headers.length()==3&&guid(trusted).isNotEmpty()&&guid(headers.optString("X-Emby-Server-Id"))==guid(trusted)&&listOf("X-Emby-Token","X-Emby-Server-Id","X-Emby-User-Id").all{safe(headers.optString(it))}
  return headers.length()==0||(headers.length()==1&&headers.optString("Authorization").matches(Regex("Bearer [A-Za-z0-9._~+/-]{1,4000}={0,2}")))
 }
}
