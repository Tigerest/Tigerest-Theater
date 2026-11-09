#include <QtTest/QtTest>
#include <QTemporaryDir>
#include <QScopeGuard>
#include <QTcpServer>
#include <QTcpSocket>
#include <QThread>
#include <QElapsedTimer>
#include <QFile>
#include <algorithm>
#include <memory>
#include <MpvController>
#include "Paths.h"
#include "core/ProfileManager.h"
#include "settings/SettingsComponent.h"
#include "input/InputComponent.h"
#include "player/PlayerComponent.h"
#include "player/MpvConfigManager.h"

// Answers every HTTP request after a delay from its own thread, like Emby
// extracting an embedded subtitle track on first request.
class SlowSubtitleServer : public QObject
{
  Q_OBJECT
public:
  QAtomicInt requests;
  QAtomicInt answered;

  quint16 listen(int delayMs)
  {
    m_server = new QTcpServer(this);
    if (!m_server->listen(QHostAddress::LocalHost))
      return 0;
    connect(m_server, &QTcpServer::newConnection, this, [this, delayMs] {
      while (auto* socket = m_server->nextPendingConnection())
      {
        connect(socket, &QTcpSocket::disconnected, socket, &QObject::deleteLater);
        auto request = std::make_shared<QByteArray>();
        connect(socket, &QTcpSocket::readyRead, socket, [this, socket, request, delayMs] {
          *request += socket->readAll();
          if (!request->contains("\r\n\r\n") || socket->property("answering").toBool())
            return;
          socket->setProperty("answering", true);
          ++requests;
          QTimer::singleShot(delayMs, socket, [this, socket] {
            const QByteArray body = "1\n00:00:00,000 --> 00:01:00,000\nslow subtitle\n\n";
            socket->write("HTTP/1.1 200 OK\r\nContent-Type: application/x-subrip\r\nContent-Length: " +
                          QByteArray::number(body.size()) + "\r\nConnection: close\r\n\r\n" + body);
            socket->disconnectFromHost();
            ++answered;
          });
        });
      }
    });
    return m_server->serverPort();
  }

private:
  QTcpServer* m_server = nullptr;
};

namespace {
QStringList* g_messages = nullptr;
QtMessageHandler g_previousHandler = nullptr;

void captureMessage(QtMsgType type, const QMessageLogContext& context, const QString& message)
{
  if (g_messages)
    g_messages->append(message);
  if (g_previousHandler)
    g_previousHandler(type, context, message);
}
}

class TestPlayerAsyncMpv : public QObject
{
  Q_OBJECT
  QTemporaryDir profile;
  QString media;

  struct Mpv {
    QObject owner;
    MpvController* controller = nullptr;
    PlayerComponent player;
    Mpv()
    {
      controller = new MpvController(&owner);
      controller->init();
      player.setMpvController(controller);
      // The Render API path forces vo=libmpv, which needs a Qt scene.
      player.setNativeVideoOutput(true);
      player.initializeMpv();
      controller->setProperty("vo", "null");
      controller->setProperty("ao", "null");
      controller->setProperty("audio", "no");
    }
    ~Mpv()
    {
      mpv_set_wakeup_callback(controller->mpv(), nullptr, nullptr);
      mpv_terminate_destroy(controller->mpv());
    }
  };

  // Track of the external file at url, or an empty map.
  static QVariantMap externalTrack(MpvController* controller, const QString& url)
  {
    for (const QVariant& track : controller->getProperty("track-list").toList())
      if (track.toMap().value("external-filename").toString() == url)
        return track.toMap();
    return {};
  }

private slots:
  void initTestCase()
  {
    QVERIFY(profile.isValid());
    Paths::setConfigDir(profile.path());
    Paths::setCacheDir(profile.filePath("cache"));
    ProfileManager::Get().setActiveProfile(ProfileManager::createProfile("Async mpv fixture"));
    QVERIFY(SettingsComponent::Get().componentInitialize());
    // Leave this machine's display mode alone.
    SettingsComponent::Get().setValue(SETTINGS_SECTION_VIDEO, "hdr.auto_switch", false);
    SettingsComponent::Get().setValue(SETTINGS_SECTION_VIDEO, "refreshrate.auto_switch", false);
    QVERIFY(InputComponent::Get().componentInitialize());
    QVERIFY(MpvConfigManager::prepare());

    // Ten seconds of 64x36 raw video; libavformat reads Y4M without a codec.
    media = profile.filePath("fixture.y4m");
    QFile file(media);
    QVERIFY(file.open(QIODevice::WriteOnly));
    file.write("YUV4MPEG2 W64 H36 F25:1 Ip A1:1 C420jpeg\n");
    const QByteArray frame(64 * 36 * 3 / 2, char(0x80));
    for (int i = 0; i < 250; ++i)
      file.write(QByteArray("FRAME\n") + frame);
  }

  // A slow external subtitle holds the item in on_preloaded, never the GUI
  // thread. Report: Emby answered Stream.ass after 8 s; the window froze.
  void externalSubtitleKeepsGuiResponsive()
  {
    QThread serverThread;
    auto* server = new SlowSubtitleServer;
    server->moveToThread(&serverThread);
    connect(&serverThread, &QThread::finished, server, &QObject::deleteLater);
    serverThread.start();
    const auto stopServer = qScopeGuard([&] { serverThread.quit(); serverThread.wait(); });
    quint16 port = 0;
    QMetaObject::invokeMethod(server, [&] { port = server->listen(1500); }, Qt::BlockingQueuedConnection);
    QVERIFY(port);
    const QString subtitle = QStringLiteral("http://127.0.0.1:%1/Subtitles/2/0/Stream.srt").arg(port);

    Mpv mpv;
    QElapsedTimer clock;
    qint64 last = 0, longestGap = 0;
    bool playedBeforeSubtitle = false;
    QTimer probe;
    connect(&probe, &QTimer::timeout, this, [&] {
      const qint64 now = clock.elapsed();
      longestGap = qMax(longestGap, now - last);
      last = now;
      if (server->answered.loadRelaxed() == 0 &&
          mpv.controller->getProperty("time-pos").metaType() == QMetaType::fromType<double>())
        playedBeforeSubtitle = true;
    });
    clock.start();
    probe.start(20);
    QVERIFY(mpv.player.load(QUrl::fromLocalFile(media).toString(), {{"autoplay", true}}, {}, QVariant(),
                            QStringLiteral("#,") + subtitle));
    QTRY_COMPARE_WITH_TIMEOUT(mpv.controller->getProperty("current-tracks/sub/external-filename").toString(),
                              subtitle, 15000);
    probe.stop();
    // A stall that ends with the subtitle selected leaves QTRY before the
    // next probe tick.
    longestGap = qMax(longestGap, clock.elapsed() - last);
    QCOMPARE(server->requests.loadRelaxed() >= 1, true);
    QVERIFY2(longestGap < 700, qPrintable(QStringLiteral("GUI thread stalled %1 ms").arg(longestGap)));
    QVERIFY2(!playedBeforeSubtitle, "the item started before its selected subtitle was loaded");
    QTRY_VERIFY_WITH_TIMEOUT(mpv.controller->getProperty("time-pos").metaType() == QMetaType::fromType<double>(),
                             5000);
    QVERIFY(mpv.player.m_pendingStreamAdds.isEmpty());

    // A newer choice made while the server is still answering wins.
    const QString late = QStringLiteral("http://127.0.0.1:%1/Subtitles/3/0/Stream.srt").arg(port);
    const int answeredBefore = server->answered.loadRelaxed();
    mpv.player.setSubtitleStream(QStringLiteral("#,") + late);
    mpv.player.setSubtitleStream(-1);
    QTRY_VERIFY_WITH_TIMEOUT(!externalTrack(mpv.controller, late).isEmpty(), 15000);
    QVERIFY(server->answered.loadRelaxed() > answeredBefore);
    QTRY_VERIFY(mpv.player.m_pendingStreamAdds.isEmpty());
    QTest::qWait(200);
    QVERIFY(!externalTrack(mpv.controller, late).value("selected").toBool());
    QVERIFY(mpv.controller->getProperty("current-tracks/sub/id").metaType() ==
            QMetaType::fromType<ErrorReturn>());
  }

  // The hook is not held for ever. Report: Emby had not answered the subtitle
  // of a 24 GB film after 73 s, so the item never started and the startup
  // watchdog stopped it at 75 s, twice. The item starts without the track and
  // takes it when the server answers.
  void slowExternalSubtitleDoesNotHoldTheStart()
  {
    QThread serverThread;
    auto* server = new SlowSubtitleServer;
    server->moveToThread(&serverThread);
    connect(&serverThread, &QThread::finished, server, &QObject::deleteLater);
    serverThread.start();
    const auto stopServer = qScopeGuard([&] { serverThread.quit(); serverThread.wait(); });
    quint16 port = 0;
    QMetaObject::invokeMethod(server, [&] { port = server->listen(3000); }, Qt::BlockingQueuedConnection);
    QVERIFY(port);
    const QString subtitle = QStringLiteral("http://127.0.0.1:%1/Subtitles/7/0/Stream.srt").arg(port);

    Mpv mpv;
    mpv.player.m_preloadedStreamWaitMs = 500;
    QStringList messages;
    g_messages = &messages;
    g_previousHandler = qInstallMessageHandler(captureMessage);
    const auto restore = qScopeGuard([] { qInstallMessageHandler(g_previousHandler); g_messages = nullptr; });
    QVERIFY(mpv.player.load(QUrl::fromLocalFile(media).toString(), {{"autoplay", true}}, {}, QVariant(),
                            QStringLiteral("#,") + subtitle));
    // Playing while the server is still working on the subtitle.
    QTRY_VERIFY_WITH_TIMEOUT(mpv.controller->getProperty("time-pos").metaType() == QMetaType::fromType<double>(),
                             2500);
    QCOMPARE(server->answered.loadRelaxed(), 0);
    QCOMPARE(server->requests.loadRelaxed(), 1);
    QVERIFY(mpv.controller->getProperty("current-tracks/sub/id").metaType() ==
            QMetaType::fromType<ErrorReturn>());
    QCOMPARE(int(mpv.player.m_pendingStreamAdds.size()), 1);
    QVERIFY(std::any_of(messages.cbegin(), messages.cend(), [](const QString& message) {
      return message.contains("starting playback without them");
    }));

    // The same request is answered later and its track is selected.
    QTRY_COMPARE_WITH_TIMEOUT(mpv.controller->getProperty("current-tracks/sub/external-filename").toString(),
                              subtitle, 15000);
    QCOMPARE(server->requests.loadRelaxed(), 1);
    QVERIFY(mpv.player.m_pendingStreamAdds.isEmpty());
    QVERIFY(std::any_of(messages.cbegin(), messages.cend(), [](const QString& message) {
      return message.contains("Late external subtitle stream loaded");
    }));
    QVERIFY(mpv.controller->getProperty("time-pos").toDouble() > 0.0);

    // A late answer for an item that has ended selects nothing in the next one.
    const QString stale = QStringLiteral("http://127.0.0.1:%1/Subtitles/8/0/Stream.srt").arg(port);
    QVERIFY(mpv.player.load(QUrl::fromLocalFile(media).toString(), {{"autoplay", true}}, {}, QVariant(),
                            QStringLiteral("#,") + stale));
    QTRY_COMPARE_WITH_TIMEOUT(int(mpv.player.m_pendingStreamAdds.size()), 1, 5000);
    QTRY_VERIFY_WITH_TIMEOUT(std::any_of(mpv.player.m_pendingStreamAdds.cbegin(), mpv.player.m_pendingStreamAdds.cend(),
                                         [](const auto& add) { return add.late; }), 2500);
    QVERIFY(mpv.player.load(QUrl::fromLocalFile(media).toString(), {{"autoplay", true}}, {}, QVariant(), -1));
    QTRY_VERIFY_WITH_TIMEOUT(mpv.player.m_pendingStreamAdds.isEmpty(), 15000);
    QTRY_VERIFY_WITH_TIMEOUT(mpv.controller->getProperty("time-pos").metaType() == QMetaType::fromType<double>(),
                             5000);
    QTest::qWait(200);
    QVERIFY(mpv.controller->getProperty("current-tracks/sub/id").metaType() ==
            QMetaType::fromType<ErrorReturn>());

    // Stopping aborts the fetch; that is not reported as a subtitle that failed.
    const QString stopped = QStringLiteral("http://127.0.0.1:%1/Subtitles/9/0/Stream.srt").arg(port);
    QVERIFY(mpv.player.load(QUrl::fromLocalFile(media).toString(), {{"autoplay", true}}, {}, QVariant(),
                            QStringLiteral("#,") + stopped));
    QTRY_VERIFY_WITH_TIMEOUT(std::any_of(mpv.player.m_pendingStreamAdds.cbegin(), mpv.player.m_pendingStreamAdds.cend(),
                                         [](const auto& add) { return add.late; }), 5000);
    mpv.player.stop();
    QTRY_VERIFY_WITH_TIMEOUT(mpv.player.m_pendingStreamAdds.isEmpty(), 15000);
    QTest::qWait(200);
    QVERIFY(std::none_of(messages.cbegin(), messages.cend(), [](const QString& message) {
      return message.contains("Late external subtitle stream failed");
    }));
  }

  // A load that fails at once can put START_FILE and END_FILE in one event
  // batch, so the state goes from error to error. Report: a cached DNS failure
  // 1 ms after the start; the retry sat on the spinner until the startup
  // watchdog gave up. Whether both events share a batch is a race between mpv
  // and the GUI thread, so the batch is delivered directly.
  void failureInOneEventBatchIsReported()
  {
    Mpv mpv;
    QSignalSpy errors(&mpv.player, &PlayerComponent::error);
    mpv_event_start_file started{};
    mpv_event_end_file ended{};
    ended.reason = MPV_END_FILE_REASON_ERROR;
    ended.error = MPV_ERROR_LOADING_FAILED;
    mpv_event start{}, end{};
    start.event_id = MPV_EVENT_START_FILE;
    start.data = &started;
    end.event_id = MPV_EVENT_END_FILE;
    end.data = &ended;
    for (int failures = 1; failures <= 3; ++failures)
    {
      mpv.player.handleMpvEvent(&start);
      mpv.player.handleMpvEvent(&end);
      mpv.player.updatePlaybackState();
      QCOMPARE(errors.count(), failures);
    }
    // A second state update for the same END_FILE stays quiet.
    mpv.player.updatePlaybackState();
    QCOMPARE(errors.count(), 3);
  }

  // Each profile option can make a paused VO recompile its shaders; the
  // GUI thread queues them instead of waiting. Report: 5.6 s freeze.
  void qualityProfileIsQueued()
  {
    const QString user = MpvConfigManager::defaultUser() + QStringLiteral(
        "\n[tigerest-async-a]\nprofile-desc=异步档位 A\ndeband=yes\ndeband-iterations=3\n"
        "glsl-shader=~~/shaders/async-a.glsl\nglsl-shader=~~/shaders/async-b.glsl\n"
        "\n[tigerest-async-b]\nprofile-desc=异步档位 B\ndeband=no\ndeband-iterations=1\n"
        "\n[tigerest-async-bad]\nprofile-desc=异步档位 C\ndeband-iterations=many\n");
    QVERIFY(MpvConfigManager::saveUser(user).ok);

    Mpv mpv;
    QTRY_VERIFY(mpv.player.m_profileRequests.isEmpty());
    QVERIFY(mpv.player.applyQualityProfile("tigerest-async-a", true));
    // Returned before mpv answered: the replies wait for this thread's loop.
    QVERIFY(!mpv.player.m_profileRequests.isEmpty());
    QTRY_VERIFY(mpv.player.m_profileRequests.isEmpty());
    QVERIFY(mpv.player.m_profileApplications.isEmpty());
    QCOMPARE(mpv.controller->getProperty("deband").toBool(), true);
    QCOMPARE(mpv.controller->getProperty("deband-iterations").toInt(), 3);
    QCOMPARE(mpv.controller->getProperty("glsl-shaders").toList().size(), 2);
    QCOMPARE(mpv.controller->getProperty("user-data/profile_menu/current").toString(),
             QStringLiteral("tigerest-async-a"));

    // Requests run in order: the last switch decides the result.
    QVERIFY(mpv.player.applyQualityProfile("tigerest-async-a", false));
    QVERIFY(mpv.player.applyQualityProfile("tigerest-async-b", false));
    QTRY_VERIFY(mpv.player.m_profileRequests.isEmpty());
    QCOMPARE(mpv.controller->getProperty("deband").toBool(), false);
    QCOMPARE(mpv.controller->getProperty("deband-iterations").toInt(), 1);
    QCOMPARE(mpv.controller->getProperty("glsl-shaders").toList().size(), 0);

    // A rejected option is still reported once mpv has answered.
    QStringList messages;
    g_messages = &messages;
    g_previousHandler = qInstallMessageHandler(captureMessage);
    const auto restore = qScopeGuard([] { qInstallMessageHandler(g_previousHandler); g_messages = nullptr; });
    QVERIFY(mpv.player.applyQualityProfile("tigerest-async-bad", false));
    QTRY_VERIFY(mpv.player.m_profileRequests.isEmpty());
    bool rejected = false;
    for (const QString& message : messages)
      rejected = rejected || (message.contains("options were rejected") && message.contains("deband-iterations"));
    QVERIFY2(rejected, qPrintable(messages.join('\n')));
  }

  // mpv log lines reach the diagnostics log as UTF-8. qPrintable() handed
  // QDebug the local code page (GBK here), which it read as UTF-8.
  void mpvLogKeepsChineseText()
  {
    Mpv mpv;
    QStringList messages;
    g_messages = &messages;
    g_previousHandler = qInstallMessageHandler(captureMessage);
    const auto restore = qScopeGuard([] { qInstallMessageHandler(g_previousHandler); g_messages = nullptr; });
    mpv.controller->command(QStringList{"print-text", QStringLiteral("装甲恶鬼村正 第 6 话")});
    QTRY_VERIFY_WITH_TIMEOUT(std::any_of(messages.cbegin(), messages.cend(), [](const QString& message) {
      return message.contains(QStringLiteral("装甲恶鬼村正 第 6 话"));
    }), 3000);
  }
};

QTEST_MAIN(TestPlayerAsyncMpv)
#include "test_player_async_mpv.moc"
