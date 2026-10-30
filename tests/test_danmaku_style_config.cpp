#include <QtTest/QtTest>

#include "player/MpvConfigManager.h"

#include <QFile>
#include <QTemporaryDir>
#include <QVariantMap>

class TestDanmakuStyleConfig : public QObject
{
  Q_OBJECT

private slots:
  void rendersPluginCompatibleOptions();
  void writesOptionsIntoTheManagedScriptOptsDirectory();
  void selectsRelayForTheInitialServer();
};

namespace
{
QVariantMap styleValues()
{
  return {
    {QStringLiteral("bold"), false},
    {QStringLiteral("fontsize"), 60},
    {QStringLiteral("outline"), 1.5},
    {QStringLiteral("shadow"), 2},
    {QStringLiteral("scrolltime"), 12},
    {QStringLiteral("opacity"), 0.8},
    {QStringLiteral("displayarea"), 0.2},
  };
}

const QString expectedConfig = QStringLiteral(
  "bold=no\n"
  "fontsize=60\n"
  "outline=1.5\n"
  "shadow=2\n"
  "scrolltime=12\n"
  "opacity=0.8\n"
  "displayarea=0.2\n")
  // Plain sans-serif lacks CJK there and mixes fallback fonts per glyph.
#if defined(Q_OS_WIN)
  + QStringLiteral("fontname=Microsoft YaHei\n")
#elif defined(Q_OS_MAC)
  + QStringLiteral("fontname=PingFang SC\n")
#endif
  ;
}

void TestDanmakuStyleConfig::rendersPluginCompatibleOptions()
{
  QCOMPARE(MpvConfigManager::danmakuStyleConfigText(styleValues()), expectedConfig);
}

void TestDanmakuStyleConfig::writesOptionsIntoTheManagedScriptOptsDirectory()
{
  QTemporaryDir configRoot;
  QVERIFY(configRoot.isValid());

  QString error;
  QVERIFY2(MpvConfigManager::writeDanmakuStyleConfig(configRoot.path(), styleValues(), &error),
           qPrintable(error));

  QFile output(configRoot.filePath(QStringLiteral("script-opts/uosc_danmaku.conf")));
  QVERIFY(output.open(QIODevice::ReadOnly | QIODevice::Text));
  QCOMPARE(QString::fromUtf8(output.readAll()), expectedConfig);
}

void TestDanmakuStyleConfig::selectsRelayForTheInitialServer()
{
  const QString local = "http://192.168.5.150:18443";
  const QString remote = "https://nas.tigerest.top:18446";
  QCOMPARE(MpvConfigManager::danmakuApiServer("http://192.168.5.150:8095/", "tigerest"), local);
  QCOMPARE(MpvConfigManager::danmakuApiServer("http://192.168.5.150:8095/", ""), local);
  QCOMPARE(MpvConfigManager::danmakuApiServer("http://nas.tigerest.top:8095/", "tigerest"), remote);
  QCOMPARE(MpvConfigManager::danmakuApiServer("http://192.168.114.114:8097/", "custom"), remote);
  QCOMPARE(MpvConfigManager::danmakuApiServer("http://192.168.5.150:8095/", "custom"), remote);
  QCOMPARE(MpvConfigManager::danmakuApiServer("http://192.168.5.150:8097/", "tigerest"), remote);
  QCOMPARE(MpvConfigManager::danmakuApiServer("http://emby.example/", "custom"), remote);
  QCOMPARE(MpvConfigManager::danmakuApiServer("https://nas.tigerest.top:18445/", "custom"), remote);
  QCOMPARE(MpvConfigManager::danmakuApiServer("", ""), remote);
}

QTEST_GUILESS_MAIN(TestDanmakuStyleConfig)

#include "test_danmaku_style_config.moc"
