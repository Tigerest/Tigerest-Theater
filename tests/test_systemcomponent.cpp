#include <QtTest/QtTest>
#include <initializer_list>
#include <QTcpServer>
#include <QTcpSocket>
#include <QScopeGuard>
#include "../src/system/SystemComponent.h"
#include "../src/settings/SettingsComponent.h"
#include "../src/settings/SettingsSection.h"
#include "../src/settings/SettingsValue.h"

class TestSystemComponent : public QObject
{
  Q_OBJECT

private slots:
  void testExtractBaseUrl_data();
  void testExtractBaseUrl();
  void testWebAppearanceScriptIsSeparatedFromNativeShellBundle();
  void testConnectivityUsesEnteredAddressBeforeWebRedirects();
  void testConnectivityUsesEnteredAddressBeforeWebRedirects_data();
  void testConnectivityReportsHttpStatus();
  void testJsLogKeepsChineseText();
};

namespace {
QStringList* g_jsLogMessages = nullptr;

void captureJsLog(QtMsgType, const QMessageLogContext&, const QString& message)
{
  if (g_jsLogMessages)
    g_jsLogMessages->append(message);
}
}

// qPrintable() handed QDebug the local code page (GBK on Chinese Windows),
// which QDebug reads as UTF-8: diagnostics reports showed U+FFFD instead.
void TestSystemComponent::testJsLogKeepsChineseText()
{
  QStringList messages;
  g_jsLogMessages = &messages;
  const QtMessageHandler previous = qInstallMessageHandler(captureJsLog);
  const auto restore = qScopeGuard([&] { qInstallMessageHandler(previous); g_jsLogMessages = nullptr; });
  SystemComponent::Get().jsLog(2, QStringLiteral(":912 media error: 播放器启动超时（30 秒）"));
  QCOMPARE(messages.size(), 1);
  QVERIFY2(messages.first().contains(QStringLiteral("播放器启动超时（30 秒）")), qUtf8Printable(messages.first()));
}

void TestSystemComponent::testExtractBaseUrl_data()
{
  QTest::addColumn<QString>("input");
  QTest::addColumn<QString>("expected");

  // Standard cases - URLs with /web
  QTest::newRow("https with /web at root")
    << "https://server.com/web/"
    << "https://server.com";

  QTest::newRow("https with /web and custom port")
    << "https://server.com:8096/web/"
    << "https://server.com:8096";

  QTest::newRow("http with /web and port 80")
    << "http://server.com:80/web/"
    << "http://server.com";

  QTest::newRow("https with /web and port 443")
    << "https://server.com:443/web/"
    << "https://server.com";

  QTest::newRow("https with /web at subpath")
    << "https://server.com/jellyfin/web/"
    << "https://server.com/jellyfin";

  QTest::newRow("https with /web, no trailing slash")
    << "https://server.com/jellyfin/web"
    << "https://server.com/jellyfin";

  QTest::newRow("https with nested path before /web")
    << "https://server.com/path/to/jellyfin/web/"
    << "https://server.com/path/to/jellyfin";

  // Case insensitivity
  QTest::newRow("https with /WEB uppercase")
    << "https://server.com/WEB/"
    << "https://server.com";

  QTest::newRow("https with /Web mixed case")
    << "https://server.com/jellyfin/Web/"
    << "https://server.com/jellyfin";

  // Fallback cases - URLs without /web
  QTest::newRow("https root without /web")
    << "https://server.com/"
    << "https://server.com";

  QTest::newRow("https with port, no /web")
    << "https://server.com:8096/"
    << "https://server.com:8096";

  QTest::newRow("http with port 80, no /web")
    << "http://server.com:80/"
    << "http://server.com";

  QTest::newRow("https with port 443, no /web")
    << "https://server.com:443/"
    << "https://server.com";

  QTest::newRow("https with path but no /web")
    << "https://server.com/some/path"
    << "https://server.com/some/path";

  QTest::newRow("http root without /web")
    << "http://server.com"
    << "http://server.com";

  // Edge cases - query strings and fragments
  QTest::newRow("https with /web and query string")
    << "https://server.com/web/?foo=bar"
    << "https://server.com";

  QTest::newRow("https with /web and fragment")
    << "https://server.com/web/#section"
    << "https://server.com";

  QTest::newRow("https with /web, query and fragment")
    << "https://server.com/jellyfin/web/?foo=bar#section"
    << "https://server.com/jellyfin";

  // Edge cases - partial matches
  QTest::newRow("https with /website (not /web)")
    << "https://server.com/website/"
    << "https://server.com/website";

  QTest::newRow("https with /webdav (not /web)")
    << "https://server.com/webdav/"
    << "https://server.com/webdav";

  // Edge cases - multiple /web occurrences (should use last)
  QTest::newRow("https with multiple /web - uses last")
    << "https://server.com/web/something/web/"
    << "https://server.com/web/something";

  // Edge cases - localhost and IP addresses
  QTest::newRow("localhost with port")
    << "http://localhost:8096/web/"
    << "http://localhost:8096";

  QTest::newRow("IPv4 address")
    << "http://192.168.1.100:8096/web/"
    << "http://192.168.1.100:8096";

  QTest::newRow("IPv6 address")
    << "http://[::1]:8096/web/"
    << "http://[::1]:8096";

  QTest::newRow("routed IP keeps external port and proxy prefix")
    << "http://192.168.114.114:8097/Emby/#/login"
    << "http://192.168.114.114:8097/Emby";

  // Edge cases - malformed/empty
  QTest::newRow("empty string")
    << ""
    << "";

  QTest::newRow("no scheme")
    << "server.com/web/"
    << "";

  QTest::newRow("only scheme")
    << "https://"
    << "";

  QTest::newRow("no host")
    << "https:///web/"
    << "";
}

void TestSystemComponent::testExtractBaseUrl()
{
  QFETCH(QString, input);
  QFETCH(QString, expected);

  QString result = SystemComponent::extractBaseUrl(input);

  QCOMPARE(result, expected);
}

void TestSystemComponent::testWebAppearanceScriptIsSeparatedFromNativeShellBundle()
{
  SettingsComponent& settings = SettingsComponent::Get();
  auto registerSection = [&settings](const QString& name,
                                     std::initializer_list<SettingsValue*> values) {
    auto* section = new SettingsSection(name, PLATFORM_ANY, 0, &settings);
    for (SettingsValue* value : values)
      section->registerSetting(value);
    settings.registerSection(section);
  };
  registerSection(SETTINGS_SECTION_PATH,
                  {new SettingsValue(QStringLiteral("startupurl_extension"),
                                     QStringLiteral("bundled"))});
  registerSection(SETTINGS_SECTION_SYSTEM,
                  {new SettingsValue(QStringLiteral("systemname"),
                                     QStringLiteral("Test Device"))});
  registerSection(SETTINGS_SECTION_MAIN,
                  {new SettingsValue(QStringLiteral("layout"),
                                     QStringLiteral("desktop"))});
  registerSection(SETTINGS_SECTION_AUDIO, {});

  SystemComponent& system = SystemComponent::Get();
  const QString nativeShell = system.getNativeShellScript();
  const QString webAppearance = system.getWebAppearanceScript();
  const QString ownershipMarker = QStringLiteral("data-tigerest-owned");
  const QString appearanceOwner = QStringLiteral("const TIGEREST_APPEARANCE_OWNER = 'web-appearance';");

  QVERIFY2(nativeShell.contains(QStringLiteral("window.NativeShell")),
           "native shell getter did not return the assembled native bundle");
  // The Mac ambient renderer legitimately uses the shared ownership attribute.
  // Only the appearance owner must remain in its separate injection world.
  QCOMPARE(nativeShell.count(appearanceOwner), 0);
#ifdef Q_OS_MAC
  QVERIFY2(nativeShell.contains(QStringLiteral("'data-tigerest-owned', 'ambient-backdrop'")),
           "the Mac shell must retain its independently owned ambient renderer");
#endif

  QVERIFY2(webAppearance.contains(QStringLiteral("web-appearance")),
           "standalone appearance getter did not return the owned appearance script");
  QCOMPARE(webAppearance.count(appearanceOwner), 1);
  QCOMPARE(webAppearance.count(ownershipMarker), 1);
}

void TestSystemComponent::testConnectivityUsesEnteredAddressBeforeWebRedirects_data()
{
  QTest::addColumn<bool>("discoverPrefix");
  QTest::newRow("explicit prefix avoids misleading root redirect") << false;
  QTest::newRow("API redirect preserves discovered prefix") << true;
}

void TestSystemComponent::testConnectivityUsesEnteredAddressBeforeWebRedirects()
{
  QFETCH(bool, discoverPrefix);
  QTcpServer server;
  QVERIFY(server.listen(QHostAddress::LocalHost));
  QStringList requests;
  connect(&server, &QTcpServer::newConnection, &server, [&]() {
    auto* socket = server.nextPendingConnection();
    connect(socket, &QTcpSocket::disconnected, socket, &QObject::deleteLater);
    connect(socket, &QTcpSocket::readyRead, socket, [&, socket]() {
      QByteArray buffer = socket->property("request").toByteArray() + socket->readAll();
      socket->setProperty("request", buffer);
      if (!buffer.contains("\r\n\r\n")) return;
      requests << QString::fromUtf8(buffer.left(buffer.indexOf("\r\n")));
      if (requests.last() == "GET /emby/System/Info/Public HTTP/1.1")
        socket->write("HTTP/1.1 200 OK\r\nContent-Length: 18\r\nConnection: close\r\n\r\n{\"Id\":\"server-id\"}");
      else if (discoverPrefix && requests.last() == "GET /System/Info/Public HTTP/1.1")
        socket->write("HTTP/1.1 302 Found\r\nLocation: /emby/System/Info/Public\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      else
        socket->write("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/web/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      socket->disconnectFromHost();
    });
  });
  auto& system = SystemComponent::Get();
  QSignalSpy results(&system, &SystemComponent::serverConnectivityResult);
  const QString origin = QString("http://127.0.0.1:%1").arg(server.serverPort());
  const QString address = origin + (discoverPrefix ? "/" : "/emby/");
  system.checkServerConnectivity(address);
  QTRY_COMPARE_WITH_TIMEOUT(results.count(), 1, 8000);
  QVERIFY(results.first().at(1).toBool());
  QCOMPARE(results.first().at(2).toString(), origin + "/emby/web/index.html");
  QStringList expected;
  if (discoverPrefix) expected << "GET /System/Info/Public HTTP/1.1";
  expected << "GET /emby/System/Info/Public HTTP/1.1";
  QCOMPARE(requests, expected);
}

void TestSystemComponent::testConnectivityReportsHttpStatus()
{
  QTcpServer server;
  QVERIFY(server.listen(QHostAddress::LocalHost));
  connect(&server, &QTcpServer::newConnection, &server, [&]() {
    auto* socket = server.nextPendingConnection();
    connect(socket, &QTcpSocket::disconnected, socket, &QObject::deleteLater);
    connect(socket, &QTcpSocket::readyRead, socket, [socket]() {
      socket->readAll();
      socket->write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      socket->disconnectFromHost();
    });
  });
  auto& system = SystemComponent::Get();
  QSignalSpy results(&system, &SystemComponent::serverConnectivityResult);
  system.checkServerConnectivity(QString("http://127.0.0.1:%1").arg(server.serverPort()));
  QTRY_COMPARE_WITH_TIMEOUT(results.count(), 1, 8000);
  QVERIFY(!results.first().at(1).toBool());
  QVERIFY(results.first().size() >= 4);
  QVERIFY(results.first().at(3).toString().contains("403"));
}

QTEST_GUILESS_MAIN(TestSystemComponent)
#include "test_systemcomponent.moc"
