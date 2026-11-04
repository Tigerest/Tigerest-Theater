#include <QtTest/QtTest>
#include <QFontDatabase>
#include <QTextLayout>
#include <QTemporaryDir>
#include <QScopeGuard>
#include <QJsonDocument>
#include <QJsonArray>
#include <QFile>
#include <MpvController>
#include "Paths.h"
#include "core/ProfileManager.h"
#include "settings/SettingsComponent.h"
#include "input/InputComponent.h"
#include "player/PlayerComponent.h"

class TestEmbyUoscPlaylist : public QObject
{
  Q_OBJECT
  QTemporaryDir profile;
  QVariantList queue() const {
    return {QVariantMap{{"PlaylistItemId","queue-1"},{"Id","same-media"},{"Name","开篇"},{"ParentIndexNumber",1},{"IndexNumber",1}},
            QVariantMap{{"PlaylistItemId","queue-2"},{"Id","same-media"},{"Name","归来"},{"ParentIndexNumber",2},{"IndexNumber",1}},
            QVariantMap{{"PlaylistItemId","queue-3"},{"Id","media-3"},{"Name","终章"},{"ParentIndexNumber",2},{"IndexNumber",2}}};
  }
private slots:
  void initTestCase() {
    QVERIFY(profile.isValid());
    Paths::setConfigDir(profile.path()); Paths::setCacheDir(profile.filePath("cache"));
    ProfileManager::Get().setActiveProfile(ProfileManager::createProfile("UOSC queue fixture"));
    QVERIFY(SettingsComponent::Get().componentInitialize());
    qputenv("TIGEREST_MPV_CONFIG_DIR",profile.path().toUtf8());
    QFile loader(profile.filePath("uosc.lua")); QVERIFY(loader.open(QIODevice::WriteOnly));
    loader.write(QStringLiteral("dofile([=[" SOURCE_ROOT "/resources/mpv/plugins/uosc.lua]=]); mp.set_property_native('user-data/tigerest-test/uosc-ready',true)\n").toUtf8());
  }
  void queueReachesLuaWithoutMediaUrls() {
    QObject owner; auto* controller = new MpvController(&owner); controller->init();
    PlayerComponent player;
    const auto cleanup = qScopeGuard([&]{ mpv_set_wakeup_callback(controller->mpv(),nullptr,nullptr); mpv_terminate_destroy(controller->mpv()); });
    player.setMpvController(controller);
    auto items=queue(); auto first=items[0].toMap(); first.insert("Path","PRIVATE_PATH"); first.insert("PlaybackUrl","PRIVATE_URL"); items[0]=first;
    player.setWebPlaylist(items,"queue-2");
    QString raw;
    QTRY_VERIFY_WITH_TIMEOUT(!(raw=controller->getProperty("user-data/tigerest/web-playlist").toString()).isEmpty(),3000);
    const auto data=QJsonDocument::fromJson(raw.toUtf8()).object();
    QCOMPARE(data["currentItemId"].toString(),QString("queue-2"));
    QCOMPARE(data["items"].toArray().size(),3);
    QVERIFY(!raw.contains("PRIVATE_PATH")); QVERIFY(!raw.contains("PRIVATE_URL"));
    player.setWebPlaylist({},QString());
    QTRY_COMPARE_WITH_TIMEOUT(QJsonDocument::fromJson(controller->getProperty("user-data/tigerest/web-playlist").toString().toUtf8()).object()["items"].toArray().size(),0,3000);
  }
  void nativeSelectionRejectsStaleAndMediaIds() {
    QObject owner; auto* controller=new MpvController(&owner); controller->init();
    PlayerComponent player;
    const auto cleanup=qScopeGuard([&]{ mpv_set_wakeup_callback(controller->mpv(),nullptr,nullptr); mpv_terminate_destroy(controller->mpv()); });
    player.setMpvController(controller); player.initializeMpv(); player.setWebPlaylist(queue(),"queue-2");
    QSignalSpy actions(&InputComponent::Get(),&InputComponent::hostInput);
    controller->command(QStringList{"script-message","tigerest-playlist-item","queue-1"});
    QTRY_COMPARE_WITH_TIMEOUT(actions.size(),1,3000);
    QCOMPARE(actions[0][0].toStringList(),QStringList{"playlist-item:queue-1"});
    controller->command(QStringList{"script-message","tigerest-playlist-item","same-media"});
    controller->command(QStringList{"script-message","tigerest-playlist-item","stale"});
    controller->command(QStringList{"script-message","tigerest-playlist-item","queue-2"});
    QTest::qWait(100); QCOMPARE(actions.size(),1);
    player.setWebPlaylist({},QString());
    controller->command(QStringList{"script-message","tigerest-playlist-item","queue-1"});
    QTest::qWait(100); QCOMPARE(actions.size(),1);
  }
  void uoscButtonsUseQueueIdentityAndKeepLocalFallback() {
    QObject owner; auto* controller=new MpvController(&owner); controller->init();
    PlayerComponent player;
    const auto cleanup=qScopeGuard([&]{ mpv_set_wakeup_callback(controller->mpv(),nullptr,nullptr); mpv_terminate_destroy(controller->mpv()); });
    player.setMpvController(controller); player.initializeMpv();
    controller->command(QStringList{"load-script",profile.filePath("uosc.lua")});
    QTRY_VERIFY_WITH_TIMEOUT(controller->getProperty("user-data/tigerest-test/uosc-ready").toBool(),3000);
    // setWebPlaylist publishes asynchronously and a synchronous command can run
    // first, so wait until mpv holds the queue before UOSC reads it.
    const auto published=[&](const QString& current){ return QJsonDocument::fromJson(controller->getProperty("user-data/tigerest/web-playlist").toString().toUtf8()).object()["currentItemId"].toString()==current; };
    player.setWebPlaylist(queue(),"queue-2"); QTRY_VERIFY_WITH_TIMEOUT(published("queue-2"),3000);
    QSignalSpy actions(&InputComponent::Get(),&InputComponent::hostInput);
    controller->command(QStringList{"script-binding","uosc/prev"});
    QTRY_COMPARE_WITH_TIMEOUT(actions.size(),1,3000);
    QCOMPARE(actions[0][0].toStringList(),QStringList{"playlist-item:queue-1"});
    controller->command(QStringList{"script-binding","uosc/next"});
    QTRY_COMPARE_WITH_TIMEOUT(actions.size(),2,3000);
    QCOMPARE(actions[1][0].toStringList(),QStringList{"playlist-item:queue-3"});
    controller->command(QStringList{"script-binding","uosc/items"});
    QTRY_COMPARE_WITH_TIMEOUT(controller->getProperty("user-data/uosc/menu/type").toString(),QString("emby-playlist"),3000);
    // Menu type is published before layout/font initialization and the deferred
    // forced key bindings. Wait until mpv can actually dispatch both menu keys.
    const auto menuKeysAreActive = [&] {
      QStringList pending{"UP", "ENTER"};
      for (const auto& entry : controller->getProperty("input-bindings").toList()) {
        const auto binding = entry.toMap();
        if (binding.value("owner").toString() == QString("uosc") &&
            binding.value("priority", -1).toInt() >= 0)
          pending.removeAll(binding.value("key").toString());
      }
      return pending.isEmpty();
    };
    QTRY_VERIFY_WITH_TIMEOUT(menuKeysAreActive(),3000);
    controller->command(QStringList{"keypress","UP"});
    controller->command(QStringList{"keypress","ENTER"});
    QTRY_COMPARE_WITH_TIMEOUT(actions.size(),3,3000);
    QCOMPARE(actions[2][0].toStringList(),QStringList{"playlist-item:queue-1"});
    player.setWebPlaylist(queue(),"queue-3"); QTRY_VERIFY_WITH_TIMEOUT(published("queue-3"),3000);
    controller->command(QStringList{"script-binding","uosc/next"}); QTest::qWait(100); QCOMPARE(actions.size(),3);
    player.setWebPlaylist({},QString()); QTRY_VERIFY_WITH_TIMEOUT(published(QString()),3000);
    controller->command(QStringList{"script-binding","uosc/items"});
    QTRY_COMPARE_WITH_TIMEOUT(controller->getProperty("user-data/uosc/menu/type").toString(),QString("open-file"),3000);
  }
  void diagnosticIconExistsInTheShippedFont() {
    QObject owner; auto* controller=new MpvController(&owner); controller->init();
    const auto cleanup=qScopeGuard([&]{ mpv_set_wakeup_callback(controller->mpv(),nullptr,nullptr); mpv_terminate_destroy(controller->mpv()); });
    controller->setProperty("user-data/tigerest-test/profile-script",QStringLiteral(SOURCE_ROOT "/resources/mpv/plugins/profile_menu.lua"));
    controller->command(QStringList{"load-script",QStringLiteral(SOURCE_ROOT "/tests/fixtures/uosc_diagnostics_icon_probe.lua")});
    QString icon;
    QTRY_VERIFY_WITH_TIMEOUT(!(icon=controller->getProperty("user-data/tigerest-test/diagnostic-icon").toString()).isEmpty(),3000);
    const auto id=QFontDatabase::addApplicationFont(QStringLiteral(SOURCE_ROOT "/resources/mpv/fonts/uosc_icons.otf")); QVERIFY(id>=0);
    const auto families=QFontDatabase::applicationFontFamilies(id); QVERIFY(!families.isEmpty());
    QTextLayout layout(icon,QFont(families.first(),32)); layout.beginLayout(); layout.createLine(); layout.endLayout();
    QList<quint32> glyphs; for(const auto& run:layout.glyphRuns()) glyphs.append(run.glyphIndexes());
    QCOMPARE(glyphs.size(),1); QVERIFY(glyphs.first()!=0);
    QFontDatabase::removeApplicationFont(id);
  }
};
QTEST_MAIN(TestEmbyUoscPlaylist)
#include "test_emby_uosc_playlist.moc"
