#include <QtTest/QtTest>
#include <QFontDatabase>
#include <QTextLayout>
#include <QTemporaryDir>
#include <QScopeGuard>
#include <QJsonDocument>
#include <QJsonArray>
#include <QFile>
#include <QUrl>
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
  // Issue 39: Emby's skip-intro button lives in its HTML OSD, which UOSC replaces.
  void introSkipOffersAButtonOrJumps() {
    // Forty seconds of 64x36 raw video; libavformat reads Y4M without a codec.
    const QString media = profile.filePath("intro.y4m");
    {
      QFile file(media); QVERIFY(file.open(QIODevice::WriteOnly));
      file.write("YUV4MPEG2 W64 H36 F25:1 Ip A1:1 C420jpeg\n");
      const QByteArray frame(64 * 36 * 3 / 2, char(0x80));
      for (int i = 0; i < 1000; ++i) file.write(QByteArray("FRAME\n") + frame);
    }
    // Leave this machine's display mode alone.
    SettingsComponent::Get().setValue(SETTINGS_SECTION_VIDEO, "hdr.auto_switch", false);
    SettingsComponent::Get().setValue(SETTINGS_SECTION_VIDEO, "refreshrate.auto_switch", false);
    // Loading an item stops key auto-repeat, which needs the component's timer.
    QVERIFY(InputComponent::Get().componentInitialize());
    QObject owner; auto* controller=new MpvController(&owner); controller->init();
    PlayerComponent player;
    const auto cleanup=qScopeGuard([&]{ mpv_set_wakeup_callback(controller->mpv(),nullptr,nullptr); mpv_terminate_destroy(controller->mpv()); });
    // The Render API path forces vo=libmpv, which needs a Qt scene.
    player.setMpvController(controller); player.setNativeVideoOutput(true); player.initializeMpv();
    controller->setProperty("vo","null"); controller->setProperty("ao","null"); controller->setProperty("audio","no");
    controller->command(QStringList{"load-script",profile.filePath("uosc.lua")});
    QTRY_VERIFY_WITH_TIMEOUT(controller->getProperty("user-data/tigerest-test/uosc-ready").toBool(),3000);

    const auto time=[&]{ return controller->getProperty("time-pos").toDouble(); };
    const auto marker=[&]{ return QJsonDocument::fromJson(controller->getProperty("user-data/tigerest/intro-skip").toString().toUtf8()).object(); };
    const auto button=[&]{ return controller->getProperty("user-data/tigerest/intro-skip-button"); };
    const auto offered=[&]{ return button().metaType()==QMetaType::fromType<QVariantMap>(); };
    const auto seek=[&](double to){ controller->command(QStringList{"seek",QString::number(to),"absolute+exact"}); };
    const QVariantMap paused{{"autoplay",false}};
    QVERIFY(player.load(QUrl::fromLocalFile(media).toString(),paused,{},QVariant(),-1));
    QTRY_VERIFY_WITH_TIMEOUT(controller->getProperty("time-pos").metaType()==QMetaType::fromType<double>(),5000);

    // The button: offered inside the intro, the position stays the viewer's.
    player.setIntroSkip({{"start",5.0},{"end",20.0},{"auto",false}});
    QTRY_COMPARE_WITH_TIMEOUT(marker()["end"].toDouble(),20.0,3000);
    QVERIFY(!offered());
    seek(6); QTRY_VERIFY_WITH_TIMEOUT(offered(),3000);
    QVERIFY(qAbs(time()-6.0)<0.5);
    const auto rectangle=button().toMap();
    QVERIFY(rectangle["bx"].toDouble()>rectangle["ax"].toDouble()&&rectangle["by"].toDouble()>rectangle["ay"].toDouble());
    controller->command(QStringList{"script-binding","uosc/skip-intro"});
    QTRY_VERIFY_WITH_TIMEOUT(time()>=19.9,3000);
    QTRY_VERIFY_WITH_TIMEOUT(!offered(),3000);
    // Emby's margins: no offer within 5 s of the end once it was taken, within 2 s otherwise.
    seek(16); QTRY_VERIFY_WITH_TIMEOUT(qAbs(time()-16.0)<0.5,3000); QTest::qWait(200); QVERIFY(!offered());
    seek(1); QTRY_VERIFY_WITH_TIMEOUT(time()<2.0,3000);
    seek(17); QTRY_VERIFY_WITH_TIMEOUT(offered(),3000);
    seek(18.5); QTRY_VERIFY_WITH_TIMEOUT(!offered(),3000);
    // Outside the intro the binding does nothing.
    controller->command(QStringList{"script-binding","uosc/skip-intro"});
    QTest::qWait(200); QVERIFY(qAbs(time()-18.5)<0.5);

    // Automatic: one jump to the end of the intro, never a button.
    seek(1); QTRY_VERIFY_WITH_TIMEOUT(time()<2.0,3000);
    player.setIntroSkip({{"start",5.0},{"end",20.0},{"auto",true}});
    QTRY_VERIFY_WITH_TIMEOUT(marker()["auto"].toBool(),3000);
    seek(6); QTRY_VERIFY_WITH_TIMEOUT(time()>=19.9,3000);
    QVERIFY(time()<21.0); QVERIFY(!offered());

    // A marker that is no interval clears it, and so does loading an item.
    player.setIntroSkip({{"start",5.0},{"end",2.0}});
    QTRY_VERIFY_WITH_TIMEOUT(controller->getProperty("user-data/tigerest/intro-skip").toString().isEmpty(),3000);
    player.setIntroSkip({{"start",5.0},{"end",20.0}});
    QTRY_COMPARE_WITH_TIMEOUT(marker()["end"].toDouble(),20.0,3000);
    QVERIFY(player.load(QUrl::fromLocalFile(media).toString(),paused,{},QVariant(),-1));
    QVERIFY(controller->getProperty("user-data/tigerest/intro-skip").toString().isEmpty());
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
