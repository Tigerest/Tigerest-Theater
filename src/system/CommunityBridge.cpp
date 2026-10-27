#include "CommunityBridge.h"
#include "core/ProfileManager.h"
#include "core/Version.h"
#include <QCryptographicHash>
#include <QDateTime>
#include <QDir>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QBuffer>
#include <QImageReader>
#include <QPainter>
#include <QNetworkReply>
#include <QRegularExpression>
#include <QTimer>
#include <QUuid>
#ifdef Q_OS_WIN
#include <windows.h>
#include <wincred.h>
#include <aclapi.h>
#endif
#ifdef Q_OS_MACOS
#include <Security/Security.h>
#endif

namespace {
QString guid(QString value) { value.remove('-'); return QRegularExpression("^[a-fA-F0-9]{32}$").match(value).hasMatch() ? value.toLower() : QString(); }
bool safeHeader(const QString& value) { return !value.isEmpty() && value.size()<=4000 && !QRegularExpression("[\\x00-\\x20\\x7f]").match(value).hasMatch(); }
QUrl sourceUrl(const QVariantMap& session,bool image){
  const auto address=session.value("address").toString();const auto user=session.value("userId").toString();
  QUrl url(address,QUrl::StrictMode);
  if(address.size()>4096||!url.isValid()||!QStringList{"http","https"}.contains(url.scheme())||url.host().isEmpty()||url.authority().contains('@')||url.hasQuery()||url.hasFragment()||
      (url.host().compare("nas.tigerest.top",Qt::CaseInsensitive)==0&&QList<int>{18443,18446}.contains(url.port(url.scheme()=="https"?443:80)))||
      !safeHeader(session.value("token").toString())||!QRegularExpression("^[A-Za-z0-9_-]{1,128}$").match(user).hasMatch())return {};
  auto path=url.path();if(path.contains('\\')||path.contains("//")||path.split('/').contains("..")||path.split('/').contains("."))return {};
  while(path.endsWith('/'))path.chop(1);
  url.setPath(path+"/Users/"+user+(image?"/Images/Primary":""));
  if(image)url.setQuery("MaxWidth=128&MaxHeight=128&Format=png");
  return url;
}
QVariantMap pngSnapshot(const QByteArray& bytes){
  QBuffer input;input.setData(bytes);if(!input.open(QIODevice::ReadOnly))return {};
  QImageReader reader(&input);reader.setAutoTransform(true);const auto size=reader.size();
  if(!size.isValid()||size.width()>4096||size.height()>4096||qint64(size.width())*size.height()>16777216)return {};
  const auto decoded=reader.read();if(decoded.isNull())return {};
  const auto scaled=decoded.width()>128||decoded.height()>128?decoded.scaled(128,128,Qt::KeepAspectRatio,Qt::SmoothTransformation):decoded;
  // Paint into a fresh image so source metadata and animation frames never enter the PNG.
  QImage clean(scaled.size(),QImage::Format_ARGB32);clean.fill(Qt::transparent);{QPainter painter(&clean);painter.drawImage(0,0,scaled);}
  QByteArray png;QBuffer output(&png);if(!output.open(QIODevice::WriteOnly)||!clean.save(&output,"PNG")||png.isEmpty()||png.size()>262144)return {};
  return {{"hash",QString::fromLatin1(QCryptographicHash::hash(png,QCryptographicHash::Sha256).toHex())},{"imageBase64",QString::fromLatin1(png.toBase64())}};
}
bool restrictFile(const QString& path) {
#ifdef Q_OS_WIN
  HANDLE token=nullptr;
  if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token))return false;
  DWORD size=0;GetTokenInformation(token,TokenUser,nullptr,0,&size);
  QByteArray data(int(size),0);const bool got=GetTokenInformation(token,TokenUser,data.data(),size,&size);CloseHandle(token);
  if(!got)return false;
  EXPLICIT_ACCESSW access{};access.grfAccessPermissions=GENERIC_ALL;access.grfAccessMode=SET_ACCESS;
  access.grfInheritance=NO_INHERITANCE;access.Trustee.TrusteeForm=TRUSTEE_IS_SID;access.Trustee.TrusteeType=TRUSTEE_IS_USER;
  access.Trustee.ptstrName=reinterpret_cast<LPWSTR>(reinterpret_cast<TOKEN_USER*>(data.data())->User.Sid);
  PACL acl=nullptr;if(SetEntriesInAclW(1,&access,nullptr,&acl)!=ERROR_SUCCESS)return false;
  const auto code=SetNamedSecurityInfoW(const_cast<LPWSTR>(reinterpret_cast<LPCWSTR>(path.utf16())),SE_FILE_OBJECT,
    DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION,nullptr,nullptr,acl,nullptr);
  LocalFree(acl);return code==ERROR_SUCCESS;
#else
  return QFile::setPermissions(path,QFile::ReadOwner|QFile::WriteOwner);
#endif
}
}

CommunityBridge::CommunityBridge(QObject* parent,const QString& origin):QObject(parent),m_origin(origin),m_network(this) {}
QVariantMap CommunityBridge::clientHeaders(){
  // Printable ASCII only; these name the build, never a device or a person.
  const auto clean=[](QString value,int limit){value.remove(QRegularExpression("[^\\x20-\\x7e]"));return value.trimmed().left(limit);};
#if defined(Q_OS_WIN)
  const QString platform="Windows";
#elif defined(Q_OS_MACOS)
  const QString platform="macOS";
#else
  const QString platform="Linux";
#endif
  return {{"X-Tigerest-Client-Name","Tigerest Theater"},{"X-Tigerest-Client-Version",clean(Version::GetVersionString(),40)},{"X-Tigerest-Client-Platform",clean(platform,32)}};
}
bool CommunityBridge::allowed(const QVariantMap& r,const QString& trustedServer) {
  const auto path=r.value("path").toString(),method=r.value("method").toString();
  const auto responseType=r.value("responseType","json").toString();
  const bool avatarUpload=path=="/me/avatar"&&method=="PUT";
  if(!QRegularExpression("^/[a-zA-Z0-9_/-]+(?:\\?[a-zA-Z0-9%_.~=&+/-]*)?$").match(path).hasMatch() || path.contains("//") || path.contains("..") || path.size()>4096 ||
     !QStringList{"GET","POST","PUT","DELETE"}.contains(method) || r.value("body").toString().toUtf8().size()>(avatarUpload?393216:16384) ||
     ((method=="GET"||method=="DELETE")&&!r.value("body").toString().isEmpty()))return false;
  const auto headers=r.value("headers").toMap();
  if(responseType!="json"&&responseType!="image")return false;
  if(responseType=="image"&&(method!="GET"||headers.size()!=1||!headers.contains("Authorization")||
      !QRegularExpression("^/avatars/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\?v=[a-f0-9]{64}$").match(path).hasMatch()))return false;
  if(avatarUpload&&(headers.size()!=1||!headers.contains("Authorization")))return false;
  if(path=="/mapping-capabilities")return method=="GET" && headers.isEmpty();
  const bool exchange=path=="/auth/emby" && method=="POST";
  if(exchange){
    if(headers.size()!=3 || guid(trustedServer).isEmpty() || guid(headers.value("X-Emby-Server-Id").toString())!=guid(trustedServer))return false;
    for(const auto& name:{"X-Emby-Token","X-Emby-Server-Id","X-Emby-User-Id"})if(!safeHeader(headers.value(name).toString()))return false;
  }else{
    if(headers.size()>1 || (!headers.isEmpty() && (!headers.contains("Authorization") || !QRegularExpression("^Bearer [A-Za-z0-9._~+/-]{1,4000}={0,2}$").match(headers.value("Authorization").toString()).hasMatch())))return false;
  }
  return true;
}
void CommunityBridge::request(const QString& id,const QVariantMap& data) {
  if(!QRegularExpression("^[a-zA-Z0-9-]{1,80}$").match(id).hasMatch() || m_pending.contains(id))return;
  if(!allowed(data,m_trustedServer)){emit response(id,{{"status",0},{"error","INVALID_REQUEST"}});return;}
  const auto path=data.value("path").toString();
  const bool image=data.value("responseType").toString()=="image";
  const int limit=image?262144:2097152;
  if(path=="/mapping-capabilities"){
    m_mappingCapabilitiesRequest=id;
    if(m_mappingCapabilitiesStatus!=0){m_mappingCapabilitiesStatus=0;refreshMappingAuth();}
  }
  QNetworkRequest req(QUrl(m_origin+(path=="/mapping-capabilities"?QStringLiteral("/api/tigerest/v1/danmaku/capabilities"):"/community/v2"+path)));
  req.setAttribute(QNetworkRequest::RedirectPolicyAttribute,QNetworkRequest::ManualRedirectPolicy);
  req.setAttribute(QNetworkRequest::CookieLoadControlAttribute,QNetworkRequest::Manual);
  req.setAttribute(QNetworkRequest::CookieSaveControlAttribute,QNetworkRequest::Manual);
  req.setTransferTimeout(15000);req.setRawHeader("Accept",image?"image/png":"application/json");
  const auto client=clientHeaders();for(auto it=client.begin();it!=client.end();++it)req.setRawHeader(it.key().toLatin1(),it.value().toString().toLatin1());
  const auto headers=data.value("headers").toMap();for(auto it=headers.begin();it!=headers.end();++it)req.setRawHeader(it.key().toLatin1(),it.value().toString().toUtf8());
  const auto body=data.value("body").toString().toUtf8();if(!body.isEmpty())req.setHeader(QNetworkRequest::ContentTypeHeader,"application/json");
  auto* reply=m_network.sendCustomRequest(req,data.value("method").toByteArray(),body);m_pending.insert(id,reply);
  auto content=std::make_shared<QByteArray>();
  connect(reply,&QNetworkReply::readyRead,this,[reply,content,limit]{content->append(reply->readAll());if(content->size()>limit)reply->abort();});
  QTimer::singleShot(15000,reply,[reply]{if(!reply->isFinished())reply->abort();});
  connect(reply,&QNetworkReply::finished,this,[this,id,path,headers,reply,content,image,limit]{
    const bool active=m_pending.value(id)==reply;if(active)m_pending.remove(id);if(reply->isOpen())content->append(reply->readAll());
    const int status=reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    if(active){
      if(path=="/capabilities"){
        const auto cap=status==200?QJsonDocument::fromJson(*content).object().value("data").toObject():QJsonObject();
        const auto trusted=cap.value("enabled").toBool()?guid(cap.value("embyExchangeServerId").toString()):QString();
        if(trusted!=m_trustedServer){m_trustedServer=trusted;refreshMappingAuth();}
      }
      if(path=="/mapping-capabilities"&&m_mappingCapabilitiesRequest==id){
        m_mappingCapabilitiesStatus=content->size()<=2097152?status:0;refreshMappingAuth();
      }
      if(path=="/auth/emby"&&(status==401||status==403||status==503)){
        m_rejectedEmbyToken=headers.value("X-Emby-Token").toString();refreshMappingAuth();
      }
      QVariantMap result{{"status",status},{"body",QString::fromUtf8(*content)},{"headers",QVariantMap{{"retry-after",QString::fromLatin1(reply->rawHeader("Retry-After"))}}}};
      const auto mime=QString::fromLatin1(reply->rawHeader("Content-Type")).section(';',0,0).trimmed().toLower();
      if(image&&status>=200&&status<300){result.remove("body");result["bodyBase64"]=QString::fromLatin1(content->toBase64());result["headers"]=QVariantMap{{"content-type",mime}};}
      if(!status||(status>=300&&status<400)||content->size()>limit||(status>=200&&status<300&&reply->error()!=QNetworkReply::NoError)||(image&&status>=200&&status<300&&(mime!="image/png"||content->isEmpty())))result={{"status",0},{"error","NETWORK_UNAVAILABLE"}};
      emit response(id,result);
    }
    reply->deleteLater();
  });
}
void CommunityBridge::sourceAvatar(const QString& id,const QVariantMap& session){
  if(!QRegularExpression("^[a-zA-Z0-9-]{1,80}$").match(id).hasMatch()||m_pending.contains(id))return;
  if(sourceUrl(session,false).isEmpty()){emit response(id,{{"status",0},{"error","SOURCE_UNAVAILABLE"}});return;}
  m_sourceIds.insert(id);fetchSourceAvatar(id,session,false,QDateTime::currentMSecsSinceEpoch()+15000);
}
void CommunityBridge::fetchSourceAvatar(const QString& id,const QVariantMap& session,bool image,qint64 deadline){
  const auto remaining=deadline-QDateTime::currentMSecsSinceEpoch();
  if(remaining<=0){m_sourceIds.remove(id);emit response(id,{{"status",0},{"error","SOURCE_UNAVAILABLE"}});return;}
  QNetworkRequest req(sourceUrl(session,image));
  req.setAttribute(QNetworkRequest::RedirectPolicyAttribute,QNetworkRequest::ManualRedirectPolicy);
  req.setAttribute(QNetworkRequest::CookieLoadControlAttribute,QNetworkRequest::Manual);
  req.setAttribute(QNetworkRequest::CookieSaveControlAttribute,QNetworkRequest::Manual);
  req.setAttribute(QNetworkRequest::AuthenticationReuseAttribute,QNetworkRequest::Manual);
  req.setTransferTimeout(int(remaining));req.setRawHeader("Accept",image?"image/png":"application/json");req.setRawHeader("X-Emby-Token",session.value("token").toString().toUtf8());
  auto* reply=m_network.get(req);m_pending.insert(id,reply);const int limit=image?4194304:65536;
  auto content=std::make_shared<QByteArray>();
  connect(reply,&QNetworkReply::readyRead,this,[reply,content,limit]{content->append(reply->readAll());if(content->size()>limit)reply->abort();});
  QTimer::singleShot(int(remaining),reply,[reply]{if(!reply->isFinished())reply->abort();});
  connect(reply,&QNetworkReply::finished,this,[this,id,session,image,deadline,reply,content,limit]{
    const bool active=m_pending.value(id)==reply;if(active)m_pending.remove(id);if(reply->isOpen())content->append(reply->readAll());reply->deleteLater();if(!active)return;
    auto finish=[this,&id](const QVariantMap& result){m_sourceIds.remove(id);emit response(id,result);};
    const QVariantMap failure{{"status",0},{"error","SOURCE_UNAVAILABLE"}};
    if(reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt()!=200||reply->error()!=QNetworkReply::NoError||content->size()>limit||QDateTime::currentMSecsSinceEpoch()>deadline){finish(failure);return;}
    if(image){const auto snapshot=pngSnapshot(*content);finish(snapshot.isEmpty()?failure:QVariantMap{{"status",200},{"body",snapshot}});return;}
    const auto metadata=QJsonDocument::fromJson(*content).object();const auto returned=metadata.value("Id").toString(),expected=session.value("userId").toString();
    if(returned.isEmpty()||(guid(expected).isEmpty()?returned!=expected:guid(returned)!=guid(expected))){finish(failure);return;}
    const auto tag=metadata.value("PrimaryImageTag");
    if(tag.isUndefined()||tag.isNull()||(tag.isString()&&tag.toString().isEmpty())){finish({{"status",200},{"body",QVariantMap{{"hash",QVariant()},{"imageBase64",QVariant()}}}});return;}
    if(!tag.isString()||tag.toString().isEmpty()){finish(failure);return;}
    fetchSourceAvatar(id,session,true,deadline);
  });
}
void CommunityBridge::cancel(const QString& id){m_sourceIds.remove(id);auto reply=m_pending.take(id);if(reply)reply->abort();}
QVariantMap CommunityBridge::credential(const QString& op,const QString& key,const QString& value){
  if(!ProfileManager::Get().hasActiveProfile()||key.isEmpty()||key.size()>4096||value.toUtf8().size()>16000||!QStringList{"read","write","remove"}.contains(op))return {{"ok",false}};
  const auto hash=QCryptographicHash::hash((ProfileManager::activeProfile().dataDir()+"\n"+key).toUtf8(),QCryptographicHash::Sha256).toHex();
  const auto name=QStringLiteral("TigerestTheater/community/v2/")+QString::fromLatin1(hash);
  bool ok=false;QString result;
#ifdef Q_OS_WIN
  const auto target=reinterpret_cast<LPCWSTR>(name.utf16());
  if(op=="read"){
    PCREDENTIALW record=nullptr;
    if(CredReadW(target,CRED_TYPE_GENERIC,0,&record)){result=QString::fromUtf8(reinterpret_cast<const char*>(record->CredentialBlob),int(record->CredentialBlobSize));CredFree(record);ok=true;}
    else ok=GetLastError()==ERROR_NOT_FOUND;
  }else if(op=="remove")ok=CredDeleteW(target,CRED_TYPE_GENERIC,0)||GetLastError()==ERROR_NOT_FOUND;
  else {
    auto bytes=value.toUtf8();CREDENTIALW record{};record.Type=CRED_TYPE_GENERIC;record.TargetName=const_cast<LPWSTR>(target);
    record.CredentialBlobSize=DWORD(bytes.size());record.CredentialBlob=reinterpret_cast<LPBYTE>(bytes.data());record.Persist=CRED_PERSIST_LOCAL_MACHINE;
    ok=bytes.size()<=CRED_MAX_CREDENTIAL_BLOB_SIZE && CredWriteW(&record,0);bytes.fill(0);
  }
#elif defined(Q_OS_MACOS)
  const auto utf8=name.toUtf8();auto account=CFStringCreateWithBytes(nullptr,reinterpret_cast<const UInt8*>(utf8.constData()),utf8.size(),kCFStringEncodingUTF8,false);
  const void* keys[]={kSecClass,kSecAttrService,kSecAttrAccount};const void* values[]={kSecClassGenericPassword,CFSTR("TigerestTheater.community.v2"),account};
  auto query=CFDictionaryCreateMutable(nullptr,0,&kCFTypeDictionaryKeyCallBacks,&kCFTypeDictionaryValueCallBacks);
  for(int i=0;i<3;i++)CFDictionarySetValue(query,keys[i],values[i]);
  if(op=="read"){
    CFDictionarySetValue(query,kSecReturnData,kCFBooleanTrue);CFTypeRef found=nullptr;const auto status=SecItemCopyMatching(query,&found);
    ok=status==errSecSuccess||status==errSecItemNotFound;if(found){auto data=static_cast<CFDataRef>(found);result=QString::fromUtf8(reinterpret_cast<const char*>(CFDataGetBytePtr(data)),int(CFDataGetLength(data)));CFRelease(found);}
  }else if(op=="remove"){const auto status=SecItemDelete(query);ok=status==errSecSuccess||status==errSecItemNotFound;}
  else {
    auto bytes=value.toUtf8();auto data=CFDataCreate(nullptr,reinterpret_cast<const UInt8*>(bytes.constData()),bytes.size());
    const void* k[]={kSecValueData};const void* v[]={data};auto update=CFDictionaryCreate(nullptr,k,v,1,&kCFTypeDictionaryKeyCallBacks,&kCFTypeDictionaryValueCallBacks);
    auto status=SecItemUpdate(query,update);if(status==errSecItemNotFound){CFDictionarySetValue(query,kSecValueData,data);status=SecItemAdd(query,nullptr);}ok=status==errSecSuccess;
    CFRelease(update);CFRelease(data);bytes.fill(0);
  }
  CFRelease(query);CFRelease(account);
#endif
  return {{"ok",ok},{"value",result}};
}
bool CommunityBridge::setEmbySession(const QVariantMap& session){
  if(session==m_emby)return !mappingAuthFile().isEmpty();
  const auto sources=m_sourceIds;for(const auto& id:sources)cancel(id);
  m_emby=session;refreshMappingAuth();return !mappingAuthFile().isEmpty();
}
void CommunityBridge::refreshMappingAuth(){
  m_authFile.reset();m_legacyAuth=false;++m_generation;
  const auto& session=m_emby;
  bool valid=ProfileManager::Get().hasActiveProfile()&&!guid(m_trustedServer).isEmpty()&&guid(session.value("serverId").toString())==guid(m_trustedServer);
  for(const auto& key:{"token","serverId","userId"})valid=valid&&safeHeader(session.value(key).toString());
  const bool legacy=session.value("mappingAuth").toString()=="legacy";
  if(legacy)valid=valid&&m_mappingCapabilitiesStatus==404&&session.value("token").toString()!=m_rejectedEmbyToken;
  QByteArray bytes;
  if(valid&&legacy){
    const auto path=ProfileManager::activeProfile().dataDir("private/danmaku-mapping-authorization.txt");
    QFile existing(path);const QFileInfo info(existing);
    valid=info.isFile()&&!info.isSymLink()&&info.size()<=4096&&existing.open(QIODevice::ReadOnly);
    if(valid){
      bytes=existing.read(4097);
      valid=bytes.size()<=4096&&QRegularExpression("\\AAuthorization: Bearer [A-Za-z0-9._~+/=-]{1,4000}(?:\\r?\\n)?\\z").match(QString::fromLatin1(bytes)).hasMatch();
    }
  }else if(valid){
    bytes=("X-Emby-Token: "+session.value("token").toString()+"\r\nX-Emby-Server-Id: "+session.value("serverId").toString()+"\r\nX-Emby-User-Id: "+session.value("userId").toString()+"\r\n").toUtf8();
  }
  if(valid){
    const auto directory=ProfileManager::activeProfile().dataDir("private");QDir().mkpath(directory);
    auto file=std::make_unique<QTemporaryFile>(directory+"/mapping-session-XXXXXX.headers");
    if(file->open()&&restrictFile(file->fileName())){
      if(file->write(bytes)==bytes.size()&&file->flush()){file->close();m_authFile=std::move(file);m_legacyAuth=legacy;}
    }
  }
  bytes.fill(0);emit mappingAuthChanged(mappingAuthFile(),authGeneration());
}
QString CommunityBridge::mappingAuthFile()const{return m_authFile?m_authFile->fileName():QString();}
QString CommunityBridge::authGeneration()const{return (m_legacyAuth?QStringLiteral("legacy:"):QString())+QString::number(m_generation);}
