package top.tigerest.theater
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.io.ByteArrayOutputStream
import java.security.KeyStore
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class CommunityBridge(private val context:Context,private val response:(String,JSONObject)->Unit,private val authChanged:(Map<String,String>,Boolean)->Unit) {
 private val http=OkHttpClient.Builder().connectTimeout(5,TimeUnit.SECONDS).callTimeout(15,TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).build()
 private val pending=ConcurrentHashMap<String,Call>()
 private val sourceIds=ConcurrentHashMap.newKeySet<String>()
 private val prefs=context.getSharedPreferences("community-encrypted",Context.MODE_PRIVATE)
 @Volatile private var trusted=""
 @Volatile private var epoch=0L
 private var identity=""
 private var session=JSONObject()
 private var mappingCapabilitiesStatus=0
 private var mappingRequestId=""
 private var rejectedEmbyToken=""
 private var authorization=MappingAuthorization()
 fun request(id:String,r:JSONObject){
  if(!id.matches(Regex("[A-Za-z0-9-]{1,80}"))||pending.containsKey(id))return
  if(!CommunityBridgePolicy.allowed(r,trusted)){response(id,JSONObject().put("error","INVALID_REQUEST"));return}
  val path=r.getString("path");val method=r.getString("method");val generation=epoch
  val image=r.optString("responseType")=="image";val limit=if(image)262144 else 2097152
  if(path=="/mapping-capabilities")synchronized(this){mappingRequestId=id;mappingCapabilitiesStatus=0;refreshAuthorization()}
  val url=if(path=="/mapping-capabilities")"http://nas.tigerest.top:18443/api/tigerest/v1/danmaku/capabilities" else "http://nas.tigerest.top:18443/community/v2$path"
  val builder=Request.Builder().url(url).header("Accept",if(image)"image/png" else "application/json")
  ClientIdentity.headers().forEach{(name,value)->builder.header(name,value)}
  val headers=r.optJSONObject("headers")?:JSONObject();headers.keys().forEach { builder.header(it,headers.getString(it)) }
  builder.method(method,if(method in listOf("GET","DELETE"))null else r.optString("body").toRequestBody("application/json; charset=utf-8".toMediaType()))
  val call=http.newCall(builder.build());pending[id]=call
  fun finish(result:JSONObject){if(pending.remove(id,call)&&generation==epoch)response(id,result)}
  call.enqueue(object:Callback{
   override fun onFailure(call:Call,e:IOException){finish(JSONObject().put("error","NETWORK_UNAVAILABLE"))}
   override fun onResponse(call:Call,response:Response){response.use { reply->
    try{
     val bytes=reply.body?.byteStream()?.use{it.readNBytes(limit+1)}?:ByteArray(0)
     val mime=reply.header("Content-Type").orEmpty().substringBefore(';').trim().lowercase()
     if(reply.code in 300..399||bytes.size>limit||(image&&reply.isSuccessful&&(mime!="image/png"||bytes.isEmpty()))){finish(JSONObject().put("error","NETWORK_UNAVAILABLE"));return}
     if(image&&reply.isSuccessful){finish(JSONObject().put("status",reply.code).put("bodyBase64",Base64.encodeToString(bytes,Base64.NO_WRAP)).put("headers",JSONObject().put("content-type","image/png")));return}
     val body=bytes.toString(Charsets.UTF_8)
     synchronized(this@CommunityBridge){
      if(generation==epoch&&pending[id]===call){
       if(path=="/capabilities"){
        val caps=if(reply.code==200)runCatching{JSONObject(body).optJSONObject("data")}.getOrNull()else null
        trusted=if(caps?.optBoolean("enabled")==true)CommunityBridgePolicy.guid(caps.optString("embyExchangeServerId"))else ""
        refreshAuthorization()
       }
       if(path=="/mapping-capabilities"&&mappingRequestId==id){mappingCapabilitiesStatus=reply.code;refreshAuthorization()}
       if(path=="/auth/emby"&&reply.code in listOf(401,403,503)){rejectedEmbyToken=headers.optString("X-Emby-Token");refreshAuthorization()}
      }
     }
     finish(JSONObject().put("status",reply.code).put("body",body).put("headers",JSONObject().put("retry-after",reply.header("Retry-After")?:"")))
    }catch(_:Exception){finish(JSONObject().put("error","NETWORK_UNAVAILABLE"))}
   }}
  })
 }
 fun sourceAvatar(id:String,source:JSONObject){
  if(!id.matches(Regex("[A-Za-z0-9-]{1,80}"))||pending.containsKey(id))return
  val snapshot=JSONObject(source.toString())
  if(CommunityBridgePolicy.sourceUrl(snapshot,false)==null){response(id,JSONObject().put("status",0).put("error","SOURCE_UNAVAILABLE"));return}
  sourceIds.add(id);fetchSourceAvatar(id,snapshot,false,System.nanoTime()+TimeUnit.SECONDS.toNanos(15),epoch)
 }
 private fun fetchSourceAvatar(id:String,source:JSONObject,image:Boolean,deadline:Long,generation:Long){
  val url=CommunityBridgePolicy.sourceUrl(source,image)?:return
  val request=Request.Builder().url(url).header("Accept",if(image)"image/png" else "application/json").header("X-Emby-Token",source.getString("token")).build()
  val call=http.newCall(request);call.timeout().deadlineNanoTime(deadline)
  synchronized(this){if(generation!=epoch||!sourceIds.contains(id))return;pending[id]=call}
  fun finish(result:JSONObject){synchronized(this){if(pending.remove(id,call)&&sourceIds.remove(id)&&generation==epoch)response(id,result)}}
  fun failure()=JSONObject().put("status",0).put("error","SOURCE_UNAVAILABLE")
  call.enqueue(object:Callback{
   override fun onFailure(call:Call,e:IOException){finish(failure())}
   override fun onResponse(call:Call,response:Response){response.use { reply->
    try{
     if(reply.code!=200){finish(failure());return}
     val limit=if(image)4194304 else 65536
     val bytes=reply.body?.byteStream()?.use{it.readNBytes(limit+1)}?:ByteArray(0)
     if(bytes.size>limit||System.nanoTime()>deadline){finish(failure());return}
     if(image){val snapshot=pngSnapshot(bytes);finish(if(snapshot==null)failure()else JSONObject().put("status",200).put("body",snapshot));return}
     when(CommunityBridgePolicy.avatarState(JSONObject(bytes.toString(Charsets.UTF_8)),source.getString("userId"))){
      "absent"->finish(JSONObject().put("status",200).put("body",JSONObject().put("hash",JSONObject.NULL).put("imageBase64",JSONObject.NULL)))
      "present"->{synchronized(this@CommunityBridge){if(pending[id]===call&&sourceIds.contains(id)&&generation==epoch)fetchSourceAvatar(id,source,true,deadline,generation)}}
      else->finish(failure())
     }
    }catch(_:Exception){finish(failure())}
   }}
  })
 }
 private fun pngSnapshot(bytes:ByteArray):JSONObject? {
  val dimensions=BitmapFactory.Options().apply{inJustDecodeBounds=true};BitmapFactory.decodeByteArray(bytes,0,bytes.size,dimensions)
  if(dimensions.outWidth !in 1..4096||dimensions.outHeight !in 1..4096||dimensions.outWidth.toLong()*dimensions.outHeight>16777216)return null
  val decoded=BitmapFactory.decodeByteArray(bytes,0,bytes.size,BitmapFactory.Options().apply{inPreferredConfig=Bitmap.Config.ARGB_8888})?:return null
  var scaled:Bitmap?=null;var clean:Bitmap?=null
  return try{
   val factor=minOf(1.0,128.0/decoded.width,128.0/decoded.height)
   scaled=Bitmap.createScaledBitmap(decoded,maxOf(1,(decoded.width*factor).toInt()),maxOf(1,(decoded.height*factor).toInt()),true)
   clean=Bitmap.createBitmap(scaled.width,scaled.height,Bitmap.Config.ARGB_8888);Canvas(clean).drawBitmap(scaled,0f,0f,null)
   val output=ByteArrayOutputStream();if(!clean.compress(Bitmap.CompressFormat.PNG,100,output))return null
   val png=output.toByteArray();if(png.isEmpty()||png.size>262144)return null
   JSONObject().put("hash",MessageDigest.getInstance("SHA-256").digest(png).joinToString(""){"%02x".format(it)}).put("imageBase64",Base64.encodeToString(png,Base64.NO_WRAP))
  }finally{clean?.recycle();if(scaled!==decoded)scaled?.recycle();decoded.recycle()}
 }
 fun cancel(id:String){synchronized(this){sourceIds.remove(id);pending.remove(id)?.cancel()}}
 @Synchronized fun setSession(session:JSONObject):Boolean {
  val serialized=session.toString();if(serialized==identity)return authorization.available
  sourceIds.toList().forEach{cancel(it)}
  identity=serialized;this.session=JSONObject(serialized);refreshAuthorization(true)
  return authorization.available
 }
 private fun refreshAuthorization(force:Boolean=false){
  val updated=CommunityBridgePolicy.mappingAuthorization(session,trusted,mappingCapabilitiesStatus,rejectedEmbyToken)
  if(force||updated!=authorization){authorization=updated;authChanged(updated.headers,updated.legacyEligible)}
 }
 private fun key():SecretKey {
  val store=KeyStore.getInstance("AndroidKeyStore").apply{load(null)};val alias="TigerestCommunityV2"
  (store.getKey(alias,null) as? SecretKey)?.let{return it}
  return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore").apply{init(KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())}.generateKey()
 }
 @Synchronized fun credential(op:String,contextKey:String,value:String):JSONObject {
  if(contextKey.isEmpty()||contextKey.length>4096||value.toByteArray().size>16000)return JSONObject().put("ok",false)
  return try{
   val id=MessageDigest.getInstance("SHA-256").digest(contextKey.toByteArray()).joinToString(""){"%02x".format(it)}
   var result="";val ok=when(op){
    "remove"->prefs.edit().remove(id).commit()
    "read"->{val saved=prefs.getString(id,null);if(saved!=null){val record=JSONObject(saved);val cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key(),GCMParameterSpec(128,Base64.decode(record.getString("iv"),Base64.NO_WRAP)));cipher.updateAAD(id.toByteArray());result=cipher.doFinal(Base64.decode(record.getString("data"),Base64.NO_WRAP)).toString(Charsets.UTF_8)};true}
    "write"->{val cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key());cipher.updateAAD(id.toByteArray());val record=JSONObject().put("iv",Base64.encodeToString(cipher.iv,Base64.NO_WRAP)).put("data",Base64.encodeToString(cipher.doFinal(value.toByteArray()),Base64.NO_WRAP));prefs.edit().putString(id,record.toString()).commit()}
    else->false
   };JSONObject().put("ok",ok).put("value",result)
  }catch(_:Exception){JSONObject().put("ok",false)}
 }
 @Synchronized fun clear(){epoch++;sourceIds.clear();pending.values.forEach{it.cancel()};pending.clear();trusted="";mappingCapabilitiesStatus=0;mappingRequestId="";rejectedEmbyToken="";setSession(JSONObject())}
}
