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
  void rendersMpvScriptOptionsForTheMacCompanionConfig();
  void writesOptionsIntoTheManagedScriptOptsDirectory();
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
  "displayarea=0.2\n");
}

void TestDanmakuStyleConfig::rendersPluginCompatibleOptions()
{
  QCOMPARE(MpvConfigManager::danmakuStyleConfigText(styleValues()), expectedConfig);
}

void TestDanmakuStyleConfig::rendersMpvScriptOptionsForTheMacCompanionConfig()
{
  const QString expected = QStringLiteral(
    "script-opt=uosc_danmaku-bold=no\n"
    "script-opt=uosc_danmaku-fontsize=60\n"
    "script-opt=uosc_danmaku-outline=1.5\n"
    "script-opt=uosc_danmaku-shadow=2\n"
    "script-opt=uosc_danmaku-scrolltime=12\n"
    "script-opt=uosc_danmaku-opacity=0.8\n"
    "script-opt=uosc_danmaku-displayarea=0.2\n");

  QCOMPARE(MpvConfigManager::danmakuStyleMpvOptionsText(styleValues()), expected);
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

QTEST_GUILESS_MAIN(TestDanmakuStyleConfig)

#include "test_danmaku_style_config.moc"
