#include <QtTest/QtTest>
#include <QFile>
#include <QJsonDocument>
#include <QJsonArray>
#include <QJsonObject>
#include <QTemporaryDir>
#include <QScopeGuard>
#include <MpvController>

class TestMpvConsole : public QObject
{
  Q_OBJECT
private slots:
  void disabledByDefault();
  void startupSelection_data();
  void startupSelection();
  void keybindLabels();
};

void TestMpvConsole::disabledByDefault()
{
  QFile file(QStringLiteral(SOURCE_ROOT "/resources/settings/settings_description.json"));
  QVERIFY(file.open(QIODevice::ReadOnly));
  bool found = false;
  for (const auto section : QJsonDocument::fromJson(file.readAll()).array()) {
    if (section.toObject().value("section") != "mpv") continue;
    for (const auto entry : section.toObject().value("values").toArray()) {
      const auto setting = entry.toObject();
      if (setting.value("value") != "enableConsole") continue;
      found = true;
      QCOMPARE(setting.value("default"), QJsonValue(false));
    }
  }
  QVERIFY2(found, "Persistent console switch is missing");
}

void TestMpvConsole::startupSelection_data()
{
  QTest::addColumn<bool>("enabled");
  QTest::newRow("disabled") << false;
  QTest::newRow("enabled") << true;
}

void TestMpvConsole::startupSelection()
{
  QFETCH(bool, enabled);
  QTemporaryDir config;
  QVERIFY(config.isValid());
  QFile conf(config.filePath("mpv.conf"));
  QVERIFY(conf.open(QIODevice::WriteOnly));
  // An old user file must not silently defeat the new application switch.
  conf.write(enabled ? "load-osd-console=no\n" : "load-osd-console=yes\n");
  conf.close();
  const auto oldRoot = qgetenv("TIGEREST_MPV_CONFIG_DIR");
  const auto oldConsole = qgetenv("TIGEREST_MPV_CONSOLE");
  const auto restore = qScopeGuard([&] {
    if (oldRoot.isNull()) qunsetenv("TIGEREST_MPV_CONFIG_DIR");
    else qputenv("TIGEREST_MPV_CONFIG_DIR", oldRoot);
    if (oldConsole.isNull()) qunsetenv("TIGEREST_MPV_CONSOLE");
    else qputenv("TIGEREST_MPV_CONSOLE", oldConsole);
  });
  qputenv("TIGEREST_MPV_CONFIG_DIR", config.path().toUtf8());
  qputenv("TIGEREST_MPV_CONSOLE", enabled ? "yes" : "no");
  QObject owner;
  auto* controller = new MpvController(&owner);
  controller->init();
  const auto cleanup = qScopeGuard([&] {
    mpv_set_wakeup_callback(controller->mpv(), nullptr, nullptr);
    mpv_terminate_destroy(controller->mpv());
  });
  auto option = controller->getProperty("options/load-commands");
  const bool separateCommandEntry = !option.canConvert<ErrorReturn>();
  if (!separateCommandEntry)
    option = controller->getProperty("options/load-osd-console");
  QVERIFY(!option.canConvert<ErrorReturn>());
  QCOMPARE(option.toBool(), enabled);
  const char* ping[] = {"script-message-to", separateCommandEntry ? "commands" : "console", "tigerest-test-ping", nullptr};
  QTRY_COMPARE_WITH_TIMEOUT(mpv_command(controller->mpv(), ping) >= 0, enabled, 5000);
  if (separateCommandEntry) {
    QCOMPARE(controller->getProperty("options/load-console").toBool(), true);
    const char* inputPing[] = {"script-message-to", "console", "tigerest-test-ping", nullptr};
    QTRY_VERIFY_WITH_TIMEOUT(mpv_command(controller->mpv(), inputPing) >= 0, 5000);
  }
}

void TestMpvConsole::keybindLabels()
{
  QTemporaryDir root;
  QVERIFY(root.isValid());
  QFile script(root.filePath("label-test.lua"));
  QVERIFY(script.open(QIODevice::WriteOnly));
  QFile fixture(QStringLiteral(SOURCE_ROOT "/tests/test_mpv_keybind_labels.lua"));
  QVERIFY(fixture.open(QIODevice::ReadOnly));
  QFile module(QStringLiteral(SOURCE_ROOT "/resources/mpv/plugins/uosc/lib/tigerest_keybind_labels.lua"));
  QVERIFY(module.copy(root.filePath("tigerest_keybind_labels.lua")));
  script.write("local tests = (function()\n" + fixture.readAll() + "\nend)()\n");
  script.write(QStringLiteral(
      "local ok, err = pcall(tests, [=[%1]=])\n"
      "local f = assert(io.open([=[%1/result.txt]=], 'w')); f:write(ok and 'ok' or tostring(err)); f:close()\n")
      .arg(root.path()).toUtf8());
  script.close();
  const auto oldRoot = qgetenv("TIGEREST_MPV_CONFIG_DIR");
  const auto restore = qScopeGuard([&] {
    if (oldRoot.isNull()) qunsetenv("TIGEREST_MPV_CONFIG_DIR");
    else qputenv("TIGEREST_MPV_CONFIG_DIR", oldRoot);
  });
  qputenv("TIGEREST_MPV_CONFIG_DIR", root.path().toUtf8());
  QObject owner;
  auto* controller = new MpvController(&owner);
  controller->init();
  const auto cleanup = qScopeGuard([&] {
    mpv_set_wakeup_callback(controller->mpv(), nullptr, nullptr);
    mpv_terminate_destroy(controller->mpv());
  });
  const auto loaded = controller->command(QVariantList{QStringLiteral("load-script"), script.fileName()});
  QVERIFY(!loaded.canConvert<ErrorReturn>());
  QTRY_VERIFY_WITH_TIMEOUT(QFile::exists(root.filePath("result.txt")), 5000);
  QFile result(root.filePath("result.txt"));
  QVERIFY(result.open(QIODevice::ReadOnly));
  QCOMPARE(QString::fromUtf8(result.readAll()), QStringLiteral("ok"));
}

QTEST_GUILESS_MAIN(TestMpvConsole)
#include "test_mpv_console.moc"
