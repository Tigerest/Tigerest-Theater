#include <QtTest/QtTest>
#include <QFile>
#include <QTemporaryDir>
#include <QLocalSocket>
#include <QLocalServer>
#include <QJsonDocument>
#include <MpvController>

#include "Paths.h"
#include "core/ProfileManager.h"
#include "player/MpvConfigManager.h"
#include "settings/SettingsComponent.h"

class TestMpvSvp : public QObject
{
  Q_OBJECT
private slots:
  void initTestCase();
  void embeddedConfigExposesSvpIpc();
  void leavesAnotherPlayersSocketUntouched();
  void rewriteKeepsTheEndpointItsOwnMpvServes();
  void discoversVapourSynth_data();
  void discoversVapourSynth();
  void preservesExplicitVapourSynth();
  void worksWithoutVapourSynthInstalled();
  void rifeSuppressesOnlyManagedDiscovery();
  void bundledRuntimeUsesPrivatePaths();
  void rifePrefersBundledRuntimeOverExternalPath();
  void bundledVulkanOverridesDiscoveryOnly();
private:
  QTemporaryDir m_root;
};

void TestMpvSvp::bundledVulkanOverridesDiscoveryOnly()
{
  QTemporaryDir root;
  const auto oldDrivers=qgetenv("VK_DRIVER_FILES"),oldIcd=qgetenv("VK_ICD_FILENAMES");
  const auto restore=qScopeGuard([&]{
    oldDrivers.isNull()?qunsetenv("VK_DRIVER_FILES"):qputenv("VK_DRIVER_FILES",oldDrivers);
    oldIcd.isNull()?qunsetenv("VK_ICD_FILENAMES"):qputenv("VK_ICD_FILENAMES",oldIcd);
  });
  qunsetenv("VK_DRIVER_FILES");qunsetenv("VK_ICD_FILENAMES");
  const QString bin=root.filePath("Contents/MacOS");
  QVERIFY(QDir().mkpath(bin));
  MpvConfigManager::configureBundledVulkan(bin);
  QVERIFY(qEnvironmentVariableIsEmpty("VK_DRIVER_FILES"));
  const QString icd=root.filePath("Contents/Resources/vulkan/icd.d/MoltenVK_icd.json");
  QVERIFY(QDir().mkpath(QFileInfo(icd).absolutePath()));
  QFile file(icd);QVERIFY(file.open(QIODevice::WriteOnly));file.write("{}");file.close();
  MpvConfigManager::configureBundledVulkan(bin);
  QCOMPARE(QString::fromUtf8(qgetenv("VK_DRIVER_FILES")),QFileInfo(icd).canonicalFilePath());
  qputenv("VK_DRIVER_FILES","/custom/driver.json");
  MpvConfigManager::configureBundledVulkan(bin);
  QCOMPARE(qgetenv("VK_DRIVER_FILES"),QByteArray("/custom/driver.json"));
  qunsetenv("VK_DRIVER_FILES");qputenv("VK_ICD_FILENAMES","/custom/old-driver.json");
  MpvConfigManager::configureBundledVulkan(bin);
  QVERIFY(qEnvironmentVariableIsEmpty("VK_DRIVER_FILES"));
}

void TestMpvSvp::initTestCase()
{
  QVERIFY(m_root.isValid());
  Paths::setConfigDir(m_root.path());
  Paths::setCacheDir(m_root.filePath("cache"));
  ProfileManager::Get().setActiveProfile(ProfileManager::createProfile("SVP test"));
  auto& settings = SettingsComponent::Get();
  QVERIFY(settings.componentInitialize());
  settings.setValue(SETTINGS_SECTION_MPV, "configMode", "embedded");
  settings.setValue(SETTINGS_SECTION_MPV, "enableUosc", false);
  settings.setValue(SETTINGS_SECTION_MPV, "enableDanmaku", false);
}

void TestMpvSvp::embeddedConfigExposesSvpIpc()
{
  QLocalSocket existing;
  existing.connectToServer("/tmp/mpvsocket");
  if (existing.waitForConnected(100))
    QSKIP("Another player is using the standard SVP socket");
  QVERIFY(MpvConfigManager::prepare());

  QObject owner;
  auto* controller = new MpvController(&owner);
  controller->init();
  const QString endpoint = controller->getProperty("input-ipc-server").toString();
  const auto cleanup = qScopeGuard([&] {
    mpv_set_wakeup_callback(controller->mpv(), nullptr, nullptr);
    mpv_terminate_destroy(controller->mpv());
    if (endpoint == QStringLiteral("/tmp/mpvsocket"))
      QFile::remove(endpoint);
  });
  QCOMPARE(endpoint, QStringLiteral("/tmp/mpvsocket"));
  QLocalSocket socket;
  // mpv initializes its IPC listener on a worker thread. ConnectionRefused
  // ends a connection attempt immediately, so a single wait is not a readiness wait.
  QTRY_VERIFY2_WITH_TIMEOUT(([&] {
    if (socket.state() == QLocalSocket::ConnectedState) return true;
    socket.abort();
    socket.connectToServer(endpoint);
    return socket.waitForConnected(50);
  })(), qPrintable(socket.errorString()), 3000);
  socket.write("{\"command\":[\"get_property\",\"mpv-version\"],\"request_id\":42}\n");
  socket.flush();
  QJsonObject response;
  QTRY_VERIFY_WITH_TIMEOUT(([&] {
    if (response.value("request_id").toInt() == 42) return true;
    while (socket.canReadLine()) {
      const auto message = QJsonDocument::fromJson(socket.readLine()).object();
      if (message.value("request_id").toInt() == 42) { response=message;return true; }
    }
    return false; // Unsolicited mpv events may precede the command response.
  })(), 3000);
  QCOMPARE(response.value("request_id").toInt(), 42);
  QCOMPARE(response.value("error").toString(), QStringLiteral("success"));
  QVERIFY(response.value("data").toString().startsWith("mpv "));
  QCOMPARE(controller->getProperty("hr-seek-framedrop").toBool(), false);
  socket.disconnectFromServer();
}

void TestMpvSvp::leavesAnotherPlayersSocketUntouched()
{
  QLocalServer otherPlayer;
  if (!otherPlayer.listen("/tmp/mpvsocket"))
    QSKIP("Another player is using the standard SVP socket");
  const auto cleanup = qScopeGuard([&] { otherPlayer.close(); });
  QVERIFY(MpvConfigManager::prepare());
  QFile config(QDir(MpvConfigManager::activeConfigDir()).filePath("mpv.conf"));
  QVERIFY(config.open(QIODevice::ReadOnly));
  QVERIFY(!config.readAll().contains("\ninput-ipc-server=/tmp/mpvsocket\n"));
  QLocalSocket client;
  client.connectToServer("/tmp/mpvsocket");
  QVERIFY(client.waitForConnected(3000));
}

void TestMpvSvp::rewriteKeepsTheEndpointItsOwnMpvServes()
{
  QLocalSocket existing;
  existing.connectToServer("/tmp/mpvsocket");
  if (existing.waitForConnected(100))
    QSKIP("Another player is using the standard SVP socket");
  QVERIFY(MpvConfigManager::prepare());
  // The client's own mpv now serves the endpoint the file gave it. A later
  // rewrite (an editor save) must not mistake it for another player.
  QLocalServer ownMpv;
  if (!ownMpv.listen("/tmp/mpvsocket"))
    QSKIP("Another player is using the standard SVP socket");
  const auto cleanup = qScopeGuard([&] { ownMpv.close(); });
  QVERIFY(MpvConfigManager::refresh().ok);
  QFile config(QDir(MpvConfigManager::activeConfigDir()).filePath("mpv.conf"));
  QVERIFY(config.open(QIODevice::ReadOnly));
  QVERIFY(config.readAll().contains("\ninput-ipc-server=/tmp/mpvsocket\n"));
}

void TestMpvSvp::discoversVapourSynth_data()
{
  QTest::addColumn<QString>("relativeLibrary");
  QTest::newRow("python-package") << QStringLiteral("libexec/lib/python3.14/site-packages/vapoursynth/libvsscript.dylib");
  QTest::newRow("legacy") << QStringLiteral("lib/libvapoursynth-script.dylib");
}

void TestMpvSvp::rifeSuppressesOnlyManagedDiscovery()
{
  auto& settings=SettingsComponent::Get();
  settings.setValue(SETTINGS_SECTION_VIDEO,"aiRife",true);
  QVERIFY(MpvConfigManager::prepare());
  QFile config(QDir(MpvConfigManager::activeConfigDir()).filePath("mpv.conf"));
  QVERIFY(config.open(QIODevice::ReadOnly));
  QVERIFY(!config.readAll().contains("\ninput-ipc-server=/tmp/mpvsocket\n"));
  QVERIFY(MpvConfigManager::ownsDefaultSvpIpc());
  config.close();
  // An endpoint written into the user area (an external edit) is commented
  // out at startup; the client keeps owning the managed endpoint.
  QVERIFY(config.open(QIODevice::Append));
  config.write("input-ipc-server=/tmp/rife-user-explicit.sock\n");
  config.close();
  QVERIFY(MpvConfigManager::prepare());
  QVERIFY(MpvConfigManager::ownsDefaultSvpIpc());
  QVERIFY(config.open(QIODevice::ReadOnly));
  const QByteArray rewritten = config.readAll();
  config.close();
  QVERIFY2(rewritten.contains("#[已忽略:软件管理] input-ipc-server=/tmp/rife-user-explicit.sock"), rewritten.mid(qMax(0, int(rewritten.indexOf("rife-user")) - 300), 600).constData());
  // Automated tests inject their private endpoint through the test hook,
  // which the client does not treat as its own.
  qputenv("TIGEREST_MPV_TEST_OPTIONS", "input-ipc-server=/tmp/rife-user-explicit.sock");
  const auto unset = qScopeGuard([] { qunsetenv("TIGEREST_MPV_TEST_OPTIONS"); });
  QVERIFY(MpvConfigManager::prepare());
  QVERIFY(!MpvConfigManager::ownsDefaultSvpIpc());
  qunsetenv("TIGEREST_MPV_TEST_OPTIONS");
  settings.setValue(SETTINGS_SECTION_VIDEO,"aiRife",false);
  QVERIFY(MpvConfigManager::prepare());
  QVERIFY(MpvConfigManager::ownsDefaultSvpIpc());
}

void TestMpvSvp::bundledRuntimeUsesPrivatePaths()
{
  const QList<QByteArray> keys{"VSSCRIPT_PATH","PYTHONHOME","PYTHONPATH","PYTHONNOUSERSITE","PYTHONDONTWRITEBYTECODE","XDG_CONFIG_HOME","PATH"};
  QMap<QByteArray,QByteArray> before;
  for(const auto& key:keys)before[key]=qgetenv(key.constData());
  const auto restore=qScopeGuard([&]{for(const auto& key:keys){if(before[key].isNull())qunsetenv(key.constData());else qputenv(key.constData(),before[key]);}});
  QTemporaryDir root;QVERIFY(root.isValid());
  const QString contents=root.filePath("测试 App.app/Contents");
  const QString bin=contents+"/MacOS",python=contents+"/Resources/python";
  QVERIFY(QDir().mkpath(bin));QVERIFY(QDir().mkpath(python+"/site-packages"));
  for(const auto& path:QStringList{bin+"/vapoursynth",bin+"/tigerest-python",python+"/libvsscript.dylib"}){
    QFile f(path);QVERIFY(f.open(QIODevice::WriteOnly));f.close();
    QVERIFY(f.setPermissions(QFile::ReadOwner|QFile::WriteOwner|QFile::ExeOwner));
  }
  QFile manifest(contents+"/Resources/vapoursynth-runtime.json");
  QVERIFY(manifest.open(QIODevice::WriteOnly));
  manifest.write("{\"library\":\"../Resources/python/libvsscript.dylib\",\"pythonHome\":\"../Resources/python\",\"pythonPath\":\"../Resources/python/site-packages\"}");manifest.close();
  qunsetenv("VSSCRIPT_PATH");
  const QString registration=root.filePath("private-config");
  QVERIFY(MpvConfigManager::configureBundledVapourSynth(bin,registration));
  QCOMPARE(qEnvironmentVariable("PYTHONHOME"),QFileInfo(python).canonicalFilePath());
  QCOMPARE(qEnvironmentVariable("XDG_CONFIG_HOME"),registration);
  QCOMPARE(qEnvironmentVariable("VSSCRIPT_PATH"),QFileInfo(python+"/libvsscript.dylib").canonicalFilePath());
  qputenv("VSSCRIPT_PATH","/explicit/user/libvsscript.dylib");
  QVERIFY(!MpvConfigManager::configureBundledVapourSynth(bin,registration));
  QCOMPARE(qgetenv("VSSCRIPT_PATH"),QByteArray("/explicit/user/libvsscript.dylib"));
  qunsetenv("VSSCRIPT_PATH");
  QFile outside(root.filePath("outside.dylib"));QVERIFY(outside.open(QIODevice::WriteOnly));outside.close();
  QVERIFY(manifest.open(QIODevice::WriteOnly|QIODevice::Truncate));
  manifest.write("{\"library\":\"../../../outside.dylib\",\"pythonHome\":\"../Resources/python\",\"pythonPath\":\"../Resources/python/site-packages\"}");manifest.close();
  QVERIFY(!MpvConfigManager::configureBundledVapourSynth(bin,registration));
  QVERIFY(!qEnvironmentVariableIsSet("VSSCRIPT_PATH"));
}

void TestMpvSvp::rifePrefersBundledRuntimeOverExternalPath()
{
  const auto previous=qgetenv("VSSCRIPT_PATH");
  const auto restore=qScopeGuard([&]{
    if(previous.isNull())qunsetenv("VSSCRIPT_PATH");
    else qputenv("VSSCRIPT_PATH",previous);
  });
  QTemporaryDir root;QVERIFY(root.isValid());
  const QString contents=root.filePath("Tigerest Theater.app/Contents");
  const QString bin=contents+"/MacOS",python=contents+"/Resources/python";
  QVERIFY(QDir().mkpath(bin));QVERIFY(QDir().mkpath(python+"/site-packages"));
  for(const auto& path:QStringList{bin+"/vapoursynth",bin+"/tigerest-python",python+"/libvsscript.dylib"}){
    QFile f(path);QVERIFY(f.open(QIODevice::WriteOnly));f.close();
    QVERIFY(f.setPermissions(QFile::ReadOwner|QFile::WriteOwner|QFile::ExeOwner));
  }
  QFile manifest(contents+"/Resources/vapoursynth-runtime.json");
  QVERIFY(manifest.open(QIODevice::WriteOnly));
  manifest.write("{\"library\":\"../Resources/python/libvsscript.dylib\",\"pythonHome\":\"../Resources/python\",\"pythonPath\":\"../Resources/python/site-packages\"}");manifest.close();
  qputenv("VSSCRIPT_PATH","/opt/homebrew/Cellar/vapoursynth/79/libexec/lib/python3.14/site-packages/vapoursynth/libvsscript.dylib");
  QVERIFY(MpvConfigManager::configureBundledVapourSynth(bin,root.filePath("private-config"),true));
  QCOMPARE(qEnvironmentVariable("VSSCRIPT_PATH"),QFileInfo(python+"/libvsscript.dylib").canonicalFilePath());
}

void TestMpvSvp::discoversVapourSynth()
{
  QFETCH(QString, relativeLibrary);
  QTemporaryDir root;
  const QString library = root.filePath(relativeLibrary);
  QVERIFY(QDir().mkpath(QFileInfo(library).absolutePath()));
  QFile file(library);
  QVERIFY(file.open(QIODevice::WriteOnly));
  file.close();
  const auto previous = qgetenv("VSSCRIPT_PATH");
  const auto restore = qScopeGuard([&] {
    if (previous.isNull()) qunsetenv("VSSCRIPT_PATH");
    else qputenv("VSSCRIPT_PATH", previous);
  });
  qunsetenv("VSSCRIPT_PATH");
  MpvConfigManager::configureVapourSynth({root.filePath("missing"), root.path()});
  QCOMPARE(QString::fromUtf8(qgetenv("VSSCRIPT_PATH")), QFileInfo(library).canonicalFilePath());
}

void TestMpvSvp::preservesExplicitVapourSynth()
{
  const auto previous = qgetenv("VSSCRIPT_PATH");
  const auto restore = qScopeGuard([&] {
    if (previous.isNull()) qunsetenv("VSSCRIPT_PATH");
    else qputenv("VSSCRIPT_PATH", previous);
  });
  qputenv("VSSCRIPT_PATH", "/custom/vapoursynth/libvsscript.dylib");
  MpvConfigManager::configureVapourSynth({"/opt/homebrew/opt/vapoursynth"});
  QCOMPARE(qgetenv("VSSCRIPT_PATH"), QByteArray("/custom/vapoursynth/libvsscript.dylib"));
}

void TestMpvSvp::worksWithoutVapourSynthInstalled()
{
  QTemporaryDir root;
  const auto previous = qgetenv("VSSCRIPT_PATH");
  const auto restore = qScopeGuard([&] {
    if (previous.isNull()) qunsetenv("VSSCRIPT_PATH");
    else qputenv("VSSCRIPT_PATH", previous);
  });
  qunsetenv("VSSCRIPT_PATH");
  MpvConfigManager::configureVapourSynth({root.path()});
  QVERIFY(!qEnvironmentVariableIsSet("VSSCRIPT_PATH"));
}

QTEST_GUILESS_MAIN(TestMpvSvp)
#include "test_mpv_svp.moc"
