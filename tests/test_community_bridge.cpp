#include <QtTest/QtTest>
#include "system/CommunityBridge.h"
#include "core/ProfileManager.h"
#include "core/Version.h"
#include "shared/Paths.h"
#include <QNetworkProxy>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTemporaryDir>
#include <QImage>
#include <QBuffer>
#include <QCryptographicHash>
#include <functional>

static const QString FixtureOrigin="http://nas.tigerest.top:18443";
class CapabilityFixture {
public:
  QTcpServer server;
  int status=200;
  QByteArray body=R"({"data":{"enabled":true,"embyExchangeServerId":"62526c3bf747439c99327ddec5fed4a8"}})";
  QByteArray contentType="application/json";
  QList<QByteArray> requests;
  std::function<void(const QByteArray&)> configure;
  CapabilityFixture(){
    server.listen(QHostAddress::LocalHost);
    QNetworkProxy::setApplicationProxy(QNetworkProxy(QNetworkProxy::HttpProxy,"127.0.0.1",server.serverPort()));
    QObject::connect(&server,&QTcpServer::newConnection,&server,[this]{
      while(auto* socket=server.nextPendingConnection()){
        QObject::connect(socket,&QTcpSocket::readyRead,socket,[this,socket]{
          auto input=socket->property("input").toByteArray()+socket->readAll();socket->setProperty("input",input);
          if(!input.contains("\r\n\r\n")||socket->property("answered").toBool())return;
          socket->setProperty("answered",true);
          requests.append(input);if(configure)configure(input);
          socket->write("HTTP/1.1 "+QByteArray::number(status)+" Fixture\r\nConnection: close\r\nContent-Type: "+contentType+"\r\nContent-Length: "+QByteArray::number(body.size())+"\r\n\r\n"+body);
          socket->disconnectFromHost();
        });
        QObject::connect(socket,&QTcpSocket::disconnected,socket,&QObject::deleteLater);
      }
    });
  }
  ~CapabilityFixture(){QNetworkProxy::setApplicationProxy(QNetworkProxy::NoProxy);}
  bool observe(CommunityBridge& bridge,const QString& path,int code,const QVariantMap& headers={}){
    status=code;QSignalSpy responses(&bridge,&CommunityBridge::response);
    bridge.request("fixture",{{"path",path},{"method",path=="/auth/emby"?"POST":"GET"},{"headers",headers}});
    return responses.wait(3000)&&responses.first()[1].toMap().value("status").toInt()==code;
  }
};
class CommunityBridgeTest:public QObject {
  Q_OBJECT
private slots:
  void legacyMappingRequiresObservedUnsupportedApiAndTrustedIdentity(){
    QTemporaryDir directory;QVERIFY(directory.isValid());
    Paths::setConfigDir(directory.path()+"/data");Paths::setCacheDir(directory.path()+"/cache");
    ProfileManager::Get().setActiveProfile(ProfileManager::createProfile("Legacy fixture"));
    const auto legacyPath=ProfileManager::activeProfile().dataDir("private/danmaku-mapping-authorization.txt");
    QVERIFY(QDir().mkpath(QFileInfo(legacyPath).absolutePath()));
    QFile legacy(legacyPath);QVERIFY(legacy.open(QIODevice::WriteOnly));legacy.write("Authorization: Bearer synthetic-legacy-token\n");legacy.close();
    CapabilityFixture fixture;QVERIFY(fixture.server.isListening());
    const QVariantMap session{{"serverId","62526C3B-F747-439C-9932-7DDEC5FED4A8"},{"userId","fixture-user"},{"token","fixture-emby-token"},{"mappingAuth","legacy"}};
    for(int status:{0,200,401,403,503,404}){
      CommunityBridge bridge(nullptr,FixtureOrigin);QVERIFY(fixture.observe(bridge,"/capabilities",200));
      if(status)QVERIFY(fixture.observe(bridge,"/mapping-capabilities",status));
      QCOMPARE(bridge.setEmbySession(session),status==404);
      if(status!=404){QVERIFY(bridge.mappingAuthFile().isEmpty());continue;}
      QVERIFY(bridge.authGeneration().startsWith("legacy:"));
      QFile auth(bridge.mappingAuthFile());QVERIFY(auth.open(QIODevice::ReadOnly));
      QCOMPARE(auth.readAll(),QByteArray("Authorization: Bearer synthetic-legacy-token\n"));auth.close();
      QVERIFY(bridge.mappingAuthFile()!=legacyPath);
      auto external=session;external["serverId"]="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      QVERIFY(!bridge.setEmbySession(external));QVERIFY(bridge.mappingAuthFile().isEmpty());
      QVERIFY(bridge.setEmbySession(session));
      QVERIFY(fixture.observe(bridge,"/mapping-capabilities",503));
      QVERIFY(bridge.mappingAuthFile().isEmpty());
      QVERIFY(!bridge.setEmbySession(session));
    }
    for(int rejected:{401,403,503}){
      CommunityBridge bridge(nullptr,FixtureOrigin);QVERIFY(fixture.observe(bridge,"/capabilities",200));
      QVERIFY(fixture.observe(bridge,"/mapping-capabilities",404));
      QVERIFY(bridge.setEmbySession(session));
      QVariantMap headers{{"X-Emby-Token","fixture-emby-token"},{"X-Emby-Server-Id",session["serverId"]},{"X-Emby-User-Id",session["userId"]}};
      QVERIFY(fixture.observe(bridge,"/auth/emby",rejected,headers));
      QVERIFY(bridge.mappingAuthFile().isEmpty());QVERIFY(!bridge.setEmbySession(session));
      bridge.setEmbySession({});QVERIFY(!bridge.setEmbySession(session));
    }
    {
      CommunityBridge bridge(nullptr,FixtureOrigin);QVERIFY(fixture.observe(bridge,"/capabilities",200));
      auto ordinary=session;ordinary.remove("mappingAuth");QVERIFY(bridge.setEmbySession(ordinary));
      QVERIFY(!bridge.authGeneration().startsWith("legacy:"));
      QFile auth(bridge.mappingAuthFile());QVERIFY(auth.open(QIODevice::ReadOnly));
      const auto bytes=auth.readAll();QVERIFY(bytes.startsWith("X-Emby-Token: fixture-emby-token\r\n"));QVERIFY(!bytes.contains("Authorization:"));
    }
    QVERIFY(legacy.open(QIODevice::ReadOnly));QCOMPARE(legacy.readAll(),QByteArray("Authorization: Bearer synthetic-legacy-token\n"));legacy.close();
    for(const auto& invalid:{QByteArray("Authorization: Bearer fixture\r\nX-Emby-Token: injected\r\n"),QByteArray("Authorization: Bearer ")+QByteArray(4001,'x'),QByteArray("not-a-header")}){
      QVERIFY(legacy.open(QIODevice::WriteOnly|QIODevice::Truncate));legacy.write(invalid);legacy.close();
      CommunityBridge bridge(nullptr,FixtureOrigin);QVERIFY(fixture.observe(bridge,"/capabilities",200));QVERIFY(fixture.observe(bridge,"/mapping-capabilities",404));
      QVERIFY(!bridge.setEmbySession(session));QVERIFY(bridge.mappingAuthFile().isEmpty());
    }
    ProfileManager::Get().setActiveProfile(Profile());Paths::setConfigDir({});Paths::setCacheDir({});
  }
  void requestsReportTheClient(){
    CapabilityFixture fixture;QVERIFY(fixture.server.isListening());
    CommunityBridge bridge(nullptr,FixtureOrigin);QVERIFY(fixture.observe(bridge,"/capabilities",200));
    const QVariantMap exchange{{"X-Emby-Token","fixture-emby-token"},{"X-Emby-Server-Id","62526c3bf747439c99327ddec5fed4a8"},{"X-Emby-User-Id","fixture-user"}};
    QVERIFY(fixture.observe(bridge,"/auth/emby",200,exchange));
    QCOMPARE(fixture.requests.size(),2);
    for(const auto& request:fixture.requests){
      const auto lower=request.toLower();
      QVERIFY(lower.contains("\r\nx-tigerest-client-name: tigerest theater\r\n"));
      QVERIFY(lower.contains("\r\nx-tigerest-client-version: "+Version::GetVersionString().toLatin1().toLower()+"\r\n"));
#ifdef Q_OS_WIN
      QVERIFY(lower.contains("\r\nx-tigerest-client-platform: windows\r\n"));
#endif
    }
    QVERIFY(fixture.requests.last().toLower().contains("\r\nx-emby-token: fixture-emby-token\r\n"));
    const auto headers=CommunityBridge::clientHeaders();QCOMPARE(headers.size(),3);
    for(const auto& value:headers)QVERIFY(QRegularExpression("^[\\x20-\\x7e]{1,40}$").match(value.toString()).hasMatch());
  }
  void productionUsesTheHttpsService(){
    // Through the proxy fixture an HTTPS request is only a CONNECT to the service's host and port.
    CapabilityFixture fixture;QVERIFY(fixture.server.isListening());
    CommunityBridge bridge;QSignalSpy responses(&bridge,&CommunityBridge::response);
    bridge.request("fixture",{{"path","/capabilities"},{"method","GET"},{"headers",QVariantMap{}}});
    QVERIFY(responses.wait(5000));QCOMPARE(fixture.requests.size(),1);
    QVERIFY2(fixture.requests.first().startsWith("CONNECT nas.tigerest.top:18446 "),fixture.requests.first().constData());
  }
  void requestPolicy(){
    const QString trusted="62526c3bf747439c99327ddec5fed4a8";
    QVariantMap r{{"path","/me"},{"method","GET"},{"headers",QVariantMap{{"Authorization","Bearer fixture"}}}};
    QVERIFY(CommunityBridge::allowed(r,trusted));
    for(const auto& path:{"//evil.invalid","/../me","/me#secret","http://evil.invalid/","/me\\x"}){auto bad=r;bad["path"]=path;QVERIFY(!CommunityBridge::allowed(bad,trusted));}
    auto bad=r;bad["body"]="{}";QVERIFY(!CommunityBridge::allowed(bad,trusted));
    bad=r;bad["headers"]=QVariantMap{{"X-Emby-Token","must-not-leak"}};QVERIFY(!CommunityBridge::allowed(bad,trusted));
    QVariantMap exchange{{"path","/auth/emby"},{"method","POST"},{"body","{}"},{"headers",QVariantMap{{"X-Emby-Token","fixture"},{"X-Emby-User-Id","user"},{"X-Emby-Server-Id","62526C3B-F747-439C-9932-7DDEC5FED4A8"}}}};
    QVERIFY(CommunityBridge::allowed(exchange,trusted));QVERIFY(!CommunityBridge::allowed(exchange,""));QVERIFY(!CommunityBridge::allowed(exchange,"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
    bad=exchange;bad["body"]=QString(16385,'x');QVERIFY(!CommunityBridge::allowed(bad,trusted));
    bad=exchange;auto headers=bad["headers"].toMap();headers["X-Emby-Token"]="evil\r\nHost: evil.invalid";bad["headers"]=headers;QVERIFY(!CommunityBridge::allowed(bad,trusted));
  }
  void avatarRequestPolicy(){
    const QString path="/avatars/2c9b6e0e-4af8-4fd6-bc92-144604e59389?v="+QString(64,'a');
    QVariantMap request{{"path",path},{"method","GET"},{"responseType","image"},{"headers",QVariantMap{{"Authorization","Bearer fixture"}}}};
    QVERIFY(CommunityBridge::allowed(request,""));
    for(const auto& invalid:{QString("/me"),path+"&token=secret",QString("/avatars/invalid?v=")+QString(64,'a'),path.toUpper()}){
      auto r=request;r["path"]=invalid;QVERIFY(!CommunityBridge::allowed(r,""));
    }
    auto r=request;r["headers"]=QVariantMap();QVERIFY(!CommunityBridge::allowed(r,""));
    r=request;r["method"]="POST";QVERIFY(!CommunityBridge::allowed(r,""));
    r=request;r["responseType"]="arbitrary";QVERIFY(!CommunityBridge::allowed(r,""));
    r={{"path","/me/avatar"},{"method","PUT"},{"body",QString(393216,'x')},{"headers",request["headers"]}};
    QVERIFY(CommunityBridge::allowed(r,""));r["body"]=QString(393217,'x');QVERIFY(!CommunityBridge::allowed(r,""));
    r["body"]=QString(16385,'x');r["method"]="POST";QVERIFY(!CommunityBridge::allowed(r,""));
    r["method"]="PUT";r["path"]="/me/password";QVERIFY(!CommunityBridge::allowed(r,""));
  }
  void avatarBinaryResponseAndLimits(){
    CapabilityFixture fixture;CommunityBridge bridge(nullptr,FixtureOrigin);
    const QVariantMap request{{"path","/avatars/2c9b6e0e-4af8-4fd6-bc92-144604e59389?v="+QString(64,'a')},{"method","GET"},{"responseType","image"},{"headers",QVariantMap{{"Authorization","Bearer fixture"}}}};
    fixture.contentType="image/png";fixture.body=QByteArray::fromHex("89504e470d0a1a0a00ff10");
    QSignalSpy responses(&bridge,&CommunityBridge::response);bridge.request("image",request);QVERIFY(responses.wait(3000));
    auto result=responses.takeFirst()[1].toMap();QCOMPARE(result.value("bodyBase64").toString(),QString::fromLatin1(fixture.body.toBase64()));QVERIFY(!result.contains("body"));
    QCOMPARE(result.value("headers").toMap().value("content-type").toString(),QString("image/png"));
    QVERIFY(fixture.requests.last().toLower().contains("authorization: bearer fixture"));QVERIFY(!fixture.requests.last().split('\n').first().contains("fixture"));
    fixture.status=404;fixture.contentType="application/json";fixture.body=R"({"error":{"code":"NOT_FOUND"}})";
    bridge.request("missing",request);QVERIFY(responses.wait(3000));result=responses.takeFirst()[1].toMap();QCOMPARE(result.value("status").toInt(),404);QCOMPARE(result.value("body").toString(),QString::fromUtf8(fixture.body));QVERIFY(!result.contains("bodyBase64"));
    fixture.status=200;fixture.contentType="image/png";fixture.body=QByteArray(262145,'x');bridge.request("large",request);QVERIFY(responses.wait(3000));QCOMPARE(responses.takeFirst()[1].toMap().value("error").toString(),QString("NETWORK_UNAVAILABLE"));
    fixture.body="wrong-type";fixture.contentType="text/html";bridge.request("mime",request);QVERIFY(responses.wait(3000));QCOMPARE(responses.takeFirst()[1].toMap().value("error").toString(),QString("NETWORK_UNAVAILABLE"));
    fixture.status=302;bridge.request("redirect",request);QVERIFY(responses.wait(3000));QCOMPARE(responses.takeFirst()[1].toMap().value("error").toString(),QString("NETWORK_UNAVAILABLE"));
  }
  void sourceAvatarVerifiesIdentityAndNormalizesPng(){
    CapabilityFixture fixture;CommunityBridge bridge(nullptr,FixtureOrigin);QSignalSpy responses(&bridge,&CommunityBridge::response);
    const QVariantMap session{{"address","http://source.invalid/emby"},{"userId","0123456789abcdef0123456789abcdef"},{"token","own-fixture-token"}};
    QImage input(320,180,QImage::Format_RGB32);input.fill(Qt::blue);QByteArray jpeg;QBuffer encoded(&jpeg);QVERIFY(encoded.open(QIODevice::WriteOnly));QVERIFY(input.save(&encoded,"JPEG"));
    fixture.configure=[&](const QByteArray& request){fixture.status=200;if(request.split('\n').first().contains("/Images/Primary?")){fixture.contentType="image/jpeg";fixture.body=jpeg;}else{fixture.contentType="application/json";fixture.body=R"({"Id":"0123456789abcdef0123456789abcdef","PrimaryImageTag":"tag"})";}};
    bridge.sourceAvatar("source",session);QVERIFY(responses.wait(3000));auto result=responses.takeFirst()[1].toMap();QCOMPARE(result.value("status").toInt(),200);
    auto snapshot=result.value("body").toMap();const auto bytes=QByteArray::fromBase64(snapshot.value("imageBase64").toString().toLatin1());
    QCOMPARE(snapshot.value("hash").toString(),QString::fromLatin1(QCryptographicHash::hash(bytes,QCryptographicHash::Sha256).toHex()));QVERIFY(bytes.startsWith(QByteArray::fromHex("89504e470d0a1a0a")));QVERIFY(bytes.size()<=262144);
    const auto image=QImage::fromData(bytes);QCOMPARE(image.size(),QSize(128,72));
    QCOMPARE(fixture.requests.size(),2);QVERIFY(fixture.requests[0].startsWith("GET http://source.invalid/emby/Users/0123456789abcdef0123456789abcdef "));
    QVERIFY(fixture.requests[1].startsWith("GET http://source.invalid/emby/Users/0123456789abcdef0123456789abcdef/Images/Primary?MaxWidth=128&MaxHeight=128&Format=png "));
    for(const auto& request:fixture.requests){QVERIFY(request.toLower().contains("x-emby-token: own-fixture-token"));QVERIFY(!request.toLower().contains("authorization:"));QVERIFY(!request.split('\n').first().contains("own-fixture-token"));}
    bridge.sourceAvatar("source-again",session);QVERIFY(responses.wait(3000));QCOMPARE(responses.takeFirst()[1].toMap().value("body").toMap(),snapshot);
    fixture.configure=nullptr;fixture.contentType="application/json";
    for(const auto& metadata:{QByteArray(R"({"Id":"0123456789abcdef0123456789abcdef","PrimaryImageTag":null})"),QByteArray(R"({"Id":"0123456789abcdef0123456789abcdef","PrimaryImageTag":""})"),QByteArray(R"({"Id":"0123456789abcdef0123456789abcdef"})")}){
      fixture.body=metadata;bridge.sourceAvatar("absent",session);QVERIFY(responses.wait(3000));result=responses.takeFirst()[1].toMap();QCOMPARE(result.value("status").toInt(),200);QVERIFY(result.value("body").toMap().value("hash").isNull());QVERIFY(result.value("body").toMap().value("imageBase64").isNull());
    }
    for(const auto& metadata:{QByteArray(R"({"Id":"other-user","PrimaryImageTag":null})"),QByteArray(R"({"Id":"0123456789abcdef0123456789abcdef","PrimaryImageTag":7})"),QByteArray("not-json")}){
      fixture.body=metadata;bridge.sourceAvatar("invalid",session);QVERIFY(responses.wait(3000));QCOMPARE(responses.takeFirst()[1].toMap().value("error").toString(),QString("SOURCE_UNAVAILABLE"));
    }
    fixture.body=R"({"Id":"0123456789abcdef0123456789abcdef","PrimaryImageTag":null})";
    for(int status:{302,403,404,500}){fixture.status=status;bridge.sourceAvatar("failure",session);QVERIFY(responses.wait(3000));QCOMPARE(responses.takeFirst()[1].toMap().value("error").toString(),QString("SOURCE_UNAVAILABLE"));}
    fixture.status=200;fixture.configure=[&](const QByteArray& request){fixture.body=request.split('\n').first().contains("/Images/Primary?")?QByteArray("undecodable"):QByteArray(R"({"Id":"0123456789abcdef0123456789abcdef","PrimaryImageTag":"tag"})");};
    bridge.sourceAvatar("decode-failure",session);QVERIFY(responses.wait(3000));QCOMPARE(responses.takeFirst()[1].toMap().value("error").toString(),QString("SOURCE_UNAVAILABLE"));
    for(int status:{404,403,302}){
      fixture.configure=[&](const QByteArray& request){const bool image=request.split('\n').first().contains("/Images/Primary?");fixture.status=image?status:200;fixture.body=image?QByteArray("unavailable"):QByteArray(R"({"Id":"0123456789abcdef0123456789abcdef","PrimaryImageTag":"tag"})");};
      bridge.sourceAvatar("image-failure",session);QVERIFY(responses.wait(3000));QCOMPARE(responses.takeFirst()[1].toMap().value("error").toString(),QString("SOURCE_UNAVAILABLE"));
    }
    fixture.configure=nullptr;fixture.status=200;fixture.body=QByteArray(65537,'x');bridge.sourceAvatar("large-metadata",session);QVERIFY(responses.wait(3000));QCOMPARE(responses.takeFirst()[1].toMap().value("error").toString(),QString("SOURCE_UNAVAILABLE"));
    QImage oversized(4097,1,QImage::Format_ARGB32);oversized.fill(Qt::red);QByteArray oversizePng;QBuffer largeImage(&oversizePng);QVERIFY(largeImage.open(QIODevice::WriteOnly));QVERIFY(oversized.save(&largeImage,"PNG"));
    for(const auto& imageBytes:{oversizePng,QByteArray(4194305,'x')}){
      fixture.configure=[&](const QByteArray& request){fixture.body=request.split('\n').first().contains("/Images/Primary?")?imageBytes:QByteArray(R"({"Id":"0123456789abcdef0123456789abcdef","PrimaryImageTag":"tag"})");};
      bridge.sourceAvatar("oversize-image",session);QVERIFY(responses.wait(3000));QCOMPARE(responses.takeFirst()[1].toMap().value("error").toString(),QString("SOURCE_UNAVAILABLE"));
    }
    fixture.configure=nullptr;fixture.body=R"({"Id":"0123456789abcdef0123456789abcdef","PrimaryImageTag":null})";
    const auto count=fixture.requests.size();for(const auto& address:{"file:///private","http://user:secret@source.invalid","http://source.invalid?token=secret","http://source.invalid/#fragment","http://nas.tigerest.top:18443/community/v2","https://nas.tigerest.top:18446/community/v2"}){
      auto invalid=session;invalid["address"]=address;bridge.sourceAvatar("invalid-origin",invalid);QCOMPARE(responses.takeFirst()[1].toMap().value("error").toString(),QString("SOURCE_UNAVAILABLE"));
    }QCOMPARE(fixture.requests.size(),count);
    bridge.sourceAvatar("cancelled",session);bridge.cancel("cancelled");QTest::qWait(100);QVERIFY(responses.isEmpty());
    bridge.sourceAvatar("old-session",session);bridge.setEmbySession({{"userId","new-user"}});QTest::qWait(100);QVERIFY(responses.isEmpty());
  }
};
QTEST_GUILESS_MAIN(CommunityBridgeTest)
#include "test_community_bridge.moc"
