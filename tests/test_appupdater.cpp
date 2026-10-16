#include <QtTest>
#include <QJsonDocument>
#include <QJsonObject>
#include <QCryptographicHash>
#include <QTemporaryDir>
#include <QTimer>
#include "system/AppUpdater.h"

// Network I/O is the external boundary. The real updater still owns request
// policy, parsing, state transitions, filesystem writes and digest validation.
struct Response { QByteArray bytes; int status = 200; QUrl redirect; bool held = false;
  QList<QPair<QByteArray, QByteArray>> headers;
  QNetworkReply::NetworkError error = QNetworkReply::NoError;
};
class FixtureReply : public QNetworkReply
{
public:
  FixtureReply(const QNetworkRequest& request, Response response, QObject* parent) : QNetworkReply(parent), m_response(response)
  {
    setRequest(request); setUrl(request.url()); setOperation(QNetworkAccessManager::GetOperation);
    setAttribute(QNetworkRequest::HttpStatusCodeAttribute, response.status);
    for (const auto& header : response.headers) setRawHeader(header.first, header.second);
    if (!response.redirect.isEmpty()) setAttribute(QNetworkRequest::RedirectionTargetAttribute, response.redirect);
    open(QIODevice::ReadOnly | QIODevice::Unbuffered);
    if (!response.held) QTimer::singleShot(0, this, [this] { complete(); });
  }
  void complete() { if (isFinished()) return; emit readyRead(); if (m_response.error != NoError) setError(m_response.error, "Interrupted by fixture"); setFinished(true); emit finished(); }
  void abort() override { setError(OperationCanceledError, "Canceled"); setFinished(true); emit finished(); }
  qint64 bytesAvailable() const override { return m_response.bytes.size() - m_offset + QIODevice::bytesAvailable(); }
protected:
  qint64 readData(char* data, qint64 max) override
  { const auto count = qMin(max, m_response.bytes.size() - m_offset); if (count <= 0) return -1; memcpy(data, m_response.bytes.constData() + m_offset, count); m_offset += count; return count; }
private:
  Response m_response; qint64 m_offset = 0;
};
class FixtureNetwork : public QNetworkAccessManager
{
public:
  QList<Response> responses;
  QList<QUrl> requests;
  QList<QNetworkRequest> requestDetails;
protected:
  QNetworkReply* createRequest(Operation, const QNetworkRequest& request, QIODevice*) override
  {
    requests.append(request.url());
    requestDetails.append(request);
    return new FixtureReply(request, responses.isEmpty() ? Response{{}, 503} : responses.takeFirst(), this);
  }
};
static QByteArray metadata()
{
  return R"([{"tag_name":"v2.0.0","draft":false,"prerelease":false,"body":"Notes","assets":[{"name":"TigerestTheater-2.0.0-x64.exe","size":3,"digest":"sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","browser_download_url":"https://github.com/Tigerest/Tigerest-Theater/releases/download/v2.0.0/TigerestTheater-2.0.0-x64.exe"}]}])";
}
static QByteArray manifest(const QString& version, const QString& name, const QString& list = "files")
{
  return QJsonDocument(QJsonObject{{"version", version}, {list, QJsonArray{QJsonObject{{"name", name}, {"size", 3},
    {"sha256", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}}}}}).toJson();
}
static const QString Repository = "https://github.com/Tigerest/Tigerest-Theater/releases/";
class TestAppUpdater : public QObject
{
  Q_OBJECT
private slots:
  void rateLimitedCheckFallsBackToReleaseManifest()
  {
    QTemporaryDir dir; FixtureNetwork network;
    network.responses = {{{}, 403}, {{}, 302, QUrl(Repository + "tag/v2.0.0")},
      {{}, 302, QUrl("https://release-assets.githubusercontent.com/manifest")},
      {manifest("2.0.0", "TigerestTheater-2.0.0-x64.exe")}, {"abc"}};
    AppUpdater updater("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, dir.filePath("cache"), dir.filePath("skip.json"), &network, {});
    updater.check(true, true); QTRY_COMPARE(updater.state().value("status").toString(), "available");
    QCOMPARE(network.requests.mid(1, 2), (QList<QUrl>{QUrl(Repository + "latest"),
      QUrl(Repository + "download/v2.0.0/TigerestTheater-2.0.0-RELEASE-MANIFEST.json")}));
    QVERIFY(network.requestDetails[1].rawHeader("X-GitHub-Api-Version").isEmpty());
    QCOMPARE(updater.state().value("version").toString(), "2.0.0");
    QCOMPARE(updater.state().value("releaseUrl").toString(), Repository + "tag/v2.0.0");
    QVERIFY(updater.state().value("notes").toString().isEmpty());
    updater.download(); QTRY_COMPARE(updater.state().value("status").toString(), "ready");
    QCOMPARE(network.requests.last(), QUrl(Repository + "download/v2.0.0/TigerestTheater-2.0.0-x64.exe"));
  }
  void rateLimitFallbackOnlyOffersPublishedPackages_data()
  {
    QTest::addColumn<int>("package"); QTest::addColumn<QUrl>("latest");
    QTest::addColumn<int>("manifestStatus"); QTest::addColumn<QByteArray>("manifest"); QTest::addColumn<QString>("status");
    const int exe = int(AppUpdatePolicy::Package::WindowsInstaller), dmg = int(AppUpdatePolicy::Package::MacArm64);
    const QUrl latest(Repository + "tag/v2.0.0");
    QTest::newRow("already latest") << exe << QUrl(Repository + "tag/v1.0.0") << 200 << manifest("1.0.0", "TigerestTheater-1.0.0-x64.exe") << "current";
    QTest::newRow("mac manifest") << dmg << latest << 200 << manifest("2.0.0", "TigerestTheater-2.0.0-arm64.dmg", "assets") << "available";
    QTest::newRow("other repository") << exe << QUrl("https://github.com/Other/Repo/releases/tag/v2.0.0") << 200 << QByteArray() << "error";
    QTest::newRow("prerelease tag") << exe << QUrl(Repository + "tag/v2.0.0-beta") << 200 << QByteArray() << "error";
    QTest::newRow("no redirect") << exe << QUrl() << 200 << QByteArray() << "error";
    QTest::newRow("manifest missing") << dmg << latest << 404 << QByteArray() << "error";
    QTest::newRow("package not added") << dmg << latest << 200 << manifest("2.0.0", "TigerestTheater-2.0.0-x64.exe") << "error";
    QTest::newRow("other version") << exe << latest << 200 << manifest("1.9.0", "TigerestTheater-2.0.0-x64.exe") << "error";
  }
  void rateLimitFallbackOnlyOffersPublishedPackages()
  {
    QFETCH(int, package); QFETCH(QUrl, latest); QFETCH(int, manifestStatus); QFETCH(QByteArray, manifest); QFETCH(QString, status);
    QTemporaryDir dir; FixtureNetwork network;
    network.responses = {{{}, 429}, {{}, latest.isEmpty() ? 200 : 302, latest}, {manifest, manifestStatus}};
    AppUpdater updater("1.0.0", AppUpdatePolicy::Package(package), dir.filePath("cache"), dir.filePath("skip.json"), &network, {});
    updater.check(true, true); QTRY_VERIFY(updater.state().value("status") != "checking");
    QCOMPARE(updater.state().value("status").toString(), status);
    if (status == "error") QCOMPARE(updater.state().value("error").toString(), "GitHub 请求受限，请稍后重试。");
    if (network.requests.size() == 3)
      QVERIFY(network.requests[2].path().endsWith(package == int(AppUpdatePolicy::Package::MacArm64) ?
        "-APPLE-RELEASE-MANIFEST.json" : "0-RELEASE-MANIFEST.json"));
  }
  void otherApiFailuresDoNotUseTheFallback()
  {
    QTemporaryDir dir; FixtureNetwork network; network.responses = {{{}, 500}};
    AppUpdater updater("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, dir.filePath("cache"), dir.filePath("skip.json"), &network, {});
    updater.check(true, true); QTRY_COMPARE(updater.state().value("status").toString(), "error");
    QCOMPARE(updater.state().value("error").toString(), "无法获取更新，请检查网络后重试。");
    QCOMPARE(network.requests.size(), 1);
  }
  void repeatedPrefixesDoNotRefillRetryBudget_data()
  {
    QTest::addColumn<QByteArray>("etag");
    QTest::newRow("missing-etag") << QByteArray();
    QTest::newRow("weak-etag") << QByteArray("W/\"asset\"");
    QTest::newRow("ignored-range") << QByteArray("\"asset\"");
  }
  void repeatedPrefixesDoNotRefillRetryBudget()
  {
    QFETCH(QByteArray, etag);
    QTemporaryDir dir; FixtureNetwork network;
    network.responses = {{metadata()},
      {"ab", 200, {}, false, {{"ETag", etag}}, QNetworkReply::RemoteHostClosedError},
      {"a", 200, {}, false, {{"ETag", etag}}, QNetworkReply::RemoteHostClosedError},
      {"ab", 200, {}, false, {{"ETag", etag}}, QNetworkReply::RemoteHostClosedError}};
    AppUpdater updater("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, dir.filePath("cache"), dir.filePath("skip.json"), &network, {});
    updater.check(true, true); QTRY_COMPARE(updater.state().value("status").toString(), "available"); updater.download();
    QTRY_VERIFY_WITH_TIMEOUT(network.requests.size() >= 4, 10000);
    QCOMPARE(updater.state().value("retryAttempt").toInt(), 3);
    updater.cancel();
  }
  void progressRefillsRetryBudgetAndCompletesAfterRepeatedDisconnects()
  {
    QTemporaryDir dir; FixtureNetwork network;
    auto releases = QJsonDocument::fromJson(metadata()).array();
    auto release = releases.first().toObject(); auto assets = release.value("assets").toArray(); auto asset = assets.first().toObject();
    asset["size"] = 8;
    asset["digest"] = "sha256:" + QString::fromLatin1(QCryptographicHash::hash("abcdefgh", QCryptographicHash::Sha256).toHex());
    assets[0] = asset; release["assets"] = assets; releases[0] = release;
    network.responses = {{QJsonDocument(releases).toJson()},
      {"a", 200, {}, false, {{"ETag", "\"asset\""}}, QNetworkReply::RemoteHostClosedError},
      {"b", 206, {}, false, {{"ETag", "\"asset\""}, {"Content-Range", "bytes 1-7/8"}}, QNetworkReply::RemoteHostClosedError},
      {"c", 206, {}, false, {{"ETag", "\"asset\""}, {"Content-Range", "bytes 2-7/8"}}, QNetworkReply::RemoteHostClosedError},
      {"d", 206, {}, false, {{"ETag", "\"asset\""}, {"Content-Range", "bytes 3-7/8"}}, QNetworkReply::RemoteHostClosedError},
      {"e", 206, {}, false, {{"ETag", "\"asset\""}, {"Content-Range", "bytes 4-7/8"}}, QNetworkReply::RemoteHostClosedError},
      {"f", 206, {}, false, {{"ETag", "\"asset\""}, {"Content-Range", "bytes 5-7/8"}}, QNetworkReply::RemoteHostClosedError},
      {"g", 206, {}, false, {{"ETag", "\"asset\""}, {"Content-Range", "bytes 6-7/8"}}, QNetworkReply::RemoteHostClosedError},
      {"h", 206, {}, false, {{"ETag", "\"asset\""}, {"Content-Range", "bytes 7-7/8"}}}};
    AppUpdater updater("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, dir.filePath("cache"), dir.filePath("skip.json"), &network, {});
    updater.check(true, true); QTRY_COMPARE(updater.state().value("status").toString(), "available"); updater.download();
    QTRY_VERIFY_WITH_TIMEOUT(updater.state().value("status") == "ready" || updater.state().value("status") == "error", 30000);
    QCOMPARE(updater.state().value("status").toString(), "ready");
    QCOMPARE(network.requests.size(), 9);
    QCOMPARE(network.requestDetails.last().rawHeader("Range"), QByteArray("bytes=7-"));
    QCOMPARE(updater.state().value("received").toLongLong(), 8);
  }
  void synchronousPauseDoesNotStartAnOrphanRequest()
  {
    QTemporaryDir dir; FixtureNetwork network; network.responses = {{metadata()}, {"abc"}};
    AppUpdater updater("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, dir.filePath("cache"), dir.filePath("skip.json"), &network, {});
    updater.check(true, true); QTRY_COMPARE(updater.state().value("status").toString(), "available");
    connect(&updater, &AppUpdater::changed, &updater, [&](const QVariantMap& state) {
      if (state.value("status") == "downloading") updater.cancel();
    });
    updater.download(); QCOMPARE(network.requests.size(), 1);
    QCOMPARE(updater.state().value("status").toString(), "available");
  }
  void completedPackageCanBeReusedWhileFirstInstanceIsOpen()
  {
    QTemporaryDir dir; FixtureNetwork firstNetwork, secondNetwork;
    firstNetwork.responses = {{metadata()}, {"abc"}}; secondNetwork.responses = {{metadata()}};
    AppUpdater first("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, dir.filePath("cache"), dir.filePath("a.json"), &firstNetwork, {});
    AppUpdater second("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, dir.filePath("cache"), dir.filePath("b.json"), &secondNetwork, {});
    first.check(true, true); QTRY_COMPARE(first.state().value("status").toString(), "available"); first.download();
    QTRY_COMPARE(first.state().value("status").toString(), "ready");
    second.check(true, true); QTRY_COMPARE(second.state().value("status").toString(), "available"); second.download();
    QCOMPARE(second.state().value("status").toString(), "ready"); QCOMPARE(secondNetwork.requests.size(), 1);
  }
  void retryBudgetStopsAfterConsecutiveAttemptsWithoutProgress()
  {
    QTemporaryDir dir; FixtureNetwork network;
    network.responses = {{metadata()}, {{}, 503}, {{}, 503}, {{}, 503}, {{}, 503}, {{}, 503}, {{}, 503}};
    AppUpdater updater("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, dir.filePath("cache"), dir.filePath("skip.json"), &network, {});
    updater.check(true, true); QTRY_COMPARE(updater.state().value("status").toString(), "available"); updater.download();
    QTRY_COMPARE_WITH_TIMEOUT(updater.state().value("status").toString(), "error", 80000);
    QCOMPARE(network.requests.size(), 7); QCOMPARE(updater.state().value("retryAttempt").toInt(), 5);
    QVERIFY(!updater.state().value("installAfterDownload").toBool());
  }
  void cacheLockPreventsConcurrentWriters()
  {
    QTemporaryDir dir;
    FixtureNetwork firstNetwork, secondNetwork;
    firstNetwork.responses = {{metadata()}, {"a", 200, {}, true, {{"ETag", "\"asset\""}}}};
    secondNetwork.responses = {{metadata()}};
    AppUpdater first("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, dir.filePath("locked"), dir.filePath("a.json"), &firstNetwork, {});
    AppUpdater second("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, dir.filePath("locked"), dir.filePath("b.json"), &secondNetwork, {});
    first.check(true, true); QTRY_COMPARE(first.state().value("status").toString(), "available"); first.download();
    second.check(true, true); QTRY_COMPARE(second.state().value("status").toString(), "available"); second.download();
    QCOMPARE(second.state().value("status").toString(), "error");
    QCOMPARE(secondNetwork.requests.size(), 1);
    first.cancel();
  }
  void verifiedCachedPackageSurvivesRestartWithoutRedownload()
  {
    QTemporaryDir dir; FixtureNetwork network; network.responses = {{metadata()}, {"abc"}};
    {
      AppUpdater updater("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, dir.filePath("cache"), dir.filePath("skip.json"), &network, {});
      updater.check(true, true); QTRY_COMPARE(updater.state().value("status").toString(), "available");
      updater.download(); QTRY_COMPARE(updater.state().value("status").toString(), "ready");
    }
    network.responses = {{metadata()}};
    AppUpdater restarted("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, dir.filePath("cache"), dir.filePath("skip.json"), &network, {});
    restarted.check(true, true); QTRY_COMPARE(restarted.state().value("status").toString(), "available");
    restarted.download(); QCOMPARE(restarted.state().value("status").toString(), "ready");
    QCOMPARE(network.requests.size(), 3);
  }
  void interruptedTransferResumesExactRangeAndVerifies()
  {
    QTemporaryDir dir; FixtureNetwork network;
    network.responses = {{metadata()}, {"a", 200, {}, false, {{"ETag", "\"asset-v1\""}, {"Content-Length", "3"}}, QNetworkReply::RemoteHostClosedError},
      {"bc", 206, {}, false, {{"ETag", "\"asset-v1\""}, {"Content-Range", "bytes 1-2/3"}, {"Content-Length", "2"}}}};
    AppUpdater updater("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, dir.filePath("cache"), dir.filePath("skip.json"), &network, {});
    updater.check(true, true); QTRY_COMPARE(updater.state().value("status").toString(), "available");
    updater.download(); QTRY_COMPARE_WITH_TIMEOUT(updater.state().value("status").toString(), "ready", 5000);
    QCOMPARE(network.requestDetails.size(), 3);
    QCOMPARE(network.requestDetails.last().rawHeader("Range"), QByteArray("bytes=1-"));
    QCOMPARE(network.requestDetails.last().rawHeader("If-Range"), QByteArray("\"asset-v1\""));
    QCOMPARE(updater.state().value("received").toLongLong(), 3);
  }
  void restartKeepsPartialAndIgnoredRangeRestartsSafely()
  {
    QTemporaryDir dir; FixtureNetwork network;
    network.responses = {{metadata()}, {"a", 200, {}, true, {{"ETag", "\"asset-v1\""}, {"Content-Length", "3"}}}};
    {
      AppUpdater updater("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, dir.filePath("cache"), dir.filePath("skip.json"), &network, {});
      updater.check(true, true); QTRY_COMPARE(updater.state().value("status").toString(), "available");
      updater.download(); FixtureReply *reply = nullptr;
      // The metadata reply is deleteLater'd before QTRY returns; locate the pending package reply.
      for (auto *item : network.findChildren<QNetworkReply*>()) if (!item->isFinished()) reply = static_cast<FixtureReply*>(item);
      QVERIFY(reply); emit reply->readyRead();
      QCOMPARE(updater.state().value("received").toLongLong(), 1);
      updater.cancel(); QCOMPARE(updater.state().value("received").toLongLong(), 1);
    }
    network.responses = {{metadata()}, {"abc", 200, {}, false, {{"ETag", "\"asset-v2\""}, {"Content-Length", "3"}}}};
    AppUpdater restarted("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, dir.filePath("cache"), dir.filePath("skip.json"), &network, {});
    restarted.check(true, true); QTRY_COMPARE(restarted.state().value("status").toString(), "available");
    QCOMPARE(restarted.state().value("received").toLongLong(), 1);
    restarted.download(); QTRY_COMPARE(restarted.state().value("status").toString(), "ready");
    QCOMPARE(network.requestDetails.last().rawHeader("Range"), QByteArray("bytes=1-"));
    QCOMPARE(restarted.state().value("received").toLongLong(), 3);
  }
  void invalidRangeNeverAppendsAndCancellationStopsRetry()
  {
    QTemporaryDir dir; FixtureNetwork network;
    network.responses = {{metadata()}, {"a", 200, {}, false, {{"ETag", "\"asset-v1\""}}, QNetworkReply::RemoteHostClosedError},
      {"bc", 206, {}, false, {{"ETag", "\"asset-v1\""}, {"Content-Range", "bytes 0-1/3"}}}, {"abc"}};
    AppUpdater updater("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, dir.filePath("cache"), dir.filePath("skip.json"), &network, {});
    updater.check(true, true); QTRY_COMPARE(updater.state().value("status").toString(), "available"); updater.download();
    QTRY_COMPARE_WITH_TIMEOUT(updater.state().value("status").toString(), "ready", 5000);
    QCOMPARE(network.requestDetails.size(), 4);
    QVERIFY(network.requestDetails.last().rawHeader("Range").isEmpty());
    network.responses = {{metadata()}, {"a", 200, {}, false, {{"ETag", "\"asset-v1\""}}, QNetworkReply::RemoteHostClosedError}};
    AppUpdater other("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, dir.filePath("other"), dir.filePath("other-skip.json"), &network, {});
    other.check(true, true); QTRY_COMPARE(other.state().value("status").toString(), "available"); other.download();
    QTRY_VERIFY(other.state().value("retrying").toBool());
    other.cancel(); const auto count = network.requests.size();
    QTest::qWait(1200); QCOMPARE(network.requests.size(), count);
    QCOMPARE(other.state().value("received").toLongLong(), 1);
    QVERIFY(!other.state().value("installAfterDownload").toBool());
  }
  void automaticCheckRunsOnceAndManualBypassesDisabled()
  {
    QTemporaryDir dir; FixtureNetwork network; network.responses = {{metadata()}};
    AppUpdater updater("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, dir.filePath("cache"), dir.filePath("skip.json"), &network, {});
    updater.check(false, false); QCOMPARE(updater.state().value("status").toString(), "idle");
    updater.check(false, true); QVERIFY(network.requests.isEmpty());
    updater.check(true, false);
    QTRY_COMPARE(updater.state().value("status").toString(), "available");
    QCOMPARE(network.requests.first(), QUrl("https://api.github.com/repos/Tigerest/Tigerest-Theater/releases?per_page=30"));
    QVERIFY(updater.state().value("manual").toBool());
    updater.check(false, true); QCOMPARE(network.requests.size(), 1);
  }
  void skippedVersionPersistsAndManualBypassesIt()
  {
    QTemporaryDir dir; FixtureNetwork network; network.responses = {{metadata()}, {metadata()}, {metadata()}};
    {
      AppUpdater updater("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, dir.filePath("cache"), dir.filePath("skip.json"), &network, {});
      updater.check(false, true); QTRY_COMPARE(updater.state().value("status").toString(), "available");
      updater.skip(); QCOMPARE(updater.state().value("status").toString(), "idle");
    }
    AppUpdater updater("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, dir.filePath("cache"), dir.filePath("skip.json"), &network, {});
    updater.check(false, true); QTRY_COMPARE(network.requests.size(), 2);
    QTRY_COMPARE(updater.state().value("status").toString(), "idle");
    updater.check(true, true); QTRY_COMPARE(updater.state().value("status").toString(), "available");
  }
  void startupCannotDowngradeAnExplicitCheckToSilent()
  {
    QTemporaryDir dir; FixtureNetwork network; network.responses = {{metadata(), 200, {}, true}};
    AppUpdater updater("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, dir.filePath("cache"), dir.filePath("skip.json"), &network, {});
    updater.check(true, true);
    updater.check(false, true);
    QVERIFY(updater.state().value("manual").toBool());
    QCOMPARE(network.requests.size(), 1);
    updater.cancel();
  }
  void deferSurvivesDocumentReloadButNotManualCheck()
  {
    QTemporaryDir dir; FixtureNetwork network; network.responses = {{metadata()}, {metadata()}};
    AppUpdater updater("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, dir.filePath("cache"), dir.filePath("skip.json"), &network, {});
    updater.check(false, true); QTRY_COMPARE(updater.state().value("status").toString(), "available");
    updater.defer(); QVERIFY(updater.state().value("deferred").toBool());
    updater.check(false, true); QVERIFY(updater.state().value("deferred").toBool()); QCOMPARE(network.requests.size(), 1);
    updater.check(true, true); QTRY_COMPARE(updater.state().value("status").toString(), "available");
    QVERIFY(!updater.state().value("deferred").toBool());
  }
  void downloadVerifiesBeforeReadyAndInstallRechecks()
  {
    QTemporaryDir dir; FixtureNetwork network; network.responses = {{metadata()}, {"abc"}};
    QString launched; int launches = 0;
    AppUpdater updater("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, dir.filePath("cache"), dir.filePath("skip.json"), &network,
      [&](const QString& path, AppUpdatePolicy::Package package) { launched = path; ++launches; return package == AppUpdatePolicy::Package::WindowsInstaller; });
    updater.install(); QVERIFY(launched.isEmpty());
    updater.check(true, true); QTRY_COMPARE(updater.state().value("status").toString(), "available");
    updater.download(); QVERIFY(updater.state().value("installAfterDownload").toBool());
    QTRY_COMPARE(updater.state().value("status").toString(), "ready");
    QVERIFY(updater.state().value("installAfterDownload").toBool()); // Survives a web document replacement.
    QCOMPARE(updater.state().value("received").toLongLong(), 3);
    updater.install(true); QCOMPARE(updater.state().value("status").toString(), "ready"); QVERIFY(QFile::exists(launched));
    QVERIFY(!updater.state().value("installAfterDownload").toBool());
    updater.install(true); QCOMPARE(launches, 1); // A queued duplicate ready signal cannot relaunch it.
    updater.install(); QCOMPARE(launches, 2); // An installer wizard can be canceled after launch.
    QFile file(launched); QVERIFY(file.open(QIODevice::WriteOnly)); file.write("abd"); file.close();
    launched.clear(); updater.install(); QVERIFY(launched.isEmpty()); QCOMPARE(launches, 2);
    QCOMPARE(updater.state().value("status").toString(), "error");
  }
  void rejectsDamagedDownloadThenAllowsRetry()
  {
    QTemporaryDir dir; FixtureNetwork network; network.responses = {{metadata()}, {"bad"}, {"abc"}};
    AppUpdater updater("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, dir.filePath("cache"), dir.filePath("skip.json"), &network, {});
    updater.check(true, true); QTRY_COMPARE(updater.state().value("status").toString(), "available");
    updater.download(); QTRY_COMPARE(updater.state().value("status").toString(), "error");
    QVERIFY(!updater.state().value("error").toString().isEmpty());
    QCOMPARE(updater.state().value("version").toString(), "2.0.0");
    updater.download(); QTRY_COMPARE(updater.state().value("status").toString(), "ready");
  }
  void rejectsInsecureRedirectsAndOversizedMetadata()
  {
    QTemporaryDir dir; FixtureNetwork network; network.responses = {{{}, 302, QUrl("http://api.github.com/downgrade")}, {QByteArray(AppUpdatePolicy::MaximumMetadataBytes + 1, ' ')}};
    AppUpdater updater("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, dir.filePath("cache"), dir.filePath("skip.json"), &network, {});
    updater.check(true, true); QTRY_COMPARE(updater.state().value("status").toString(), "error");
    QCOMPARE(network.requests.size(), 1);
    updater.check(true, true); QTRY_COMPARE(updater.state().value("status").toString(), "error");
    QVERIFY(updater.state().value("version").toString().isEmpty());
  }
  void cancelReturnsToAvailableAndCannotInstallPartial()
  {
    QTemporaryDir dir; FixtureNetwork network; network.responses = {{metadata()}, {"ab", 200, {}, true}, {"abc"}};
    bool launched = false;
    AppUpdater updater("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, dir.filePath("cache"), dir.filePath("skip.json"), &network,
      [&](const QString&, AppUpdatePolicy::Package) { launched = true; return true; });
    updater.check(true, true); QTRY_COMPARE(updater.state().value("status").toString(), "available");
    updater.download(); QCOMPARE(updater.state().value("status").toString(), "downloading");
    updater.cancel(); QCOMPARE(updater.state().value("status").toString(), "available");
    QVERIFY(!updater.state().value("installAfterDownload").toBool());
    updater.install(); QVERIFY(!launched);
    updater.download(); QTRY_COMPARE(updater.state().value("status").toString(), "ready");
    // Mutating the completed package must never reach the OS launcher.
    QDirIterator files(dir.filePath("cache"), {"*.exe"}, QDir::Files, QDirIterator::Subdirectories);
    QVERIFY(files.hasNext()); QFile file(files.next()); QVERIFY(file.open(QIODevice::WriteOnly)); file.write("xyz"); file.close();
    updater.install(); QCOMPARE(updater.state().value("status").toString(), "error"); QVERIFY(!launched);
  }
};
QTEST_GUILESS_MAIN(TestAppUpdater)
#include "test_appupdater.moc"
