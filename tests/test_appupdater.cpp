#include <QtTest>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTemporaryDir>
#include <QTimer>
#include "system/AppUpdater.h"

// Network I/O is the external boundary. The real updater still owns request
// policy, parsing, state transitions, filesystem writes and digest validation.
// `error` ends the reply after its bytes, like Qt's transfer timeout on a stalled stream.
struct Response { QByteArray bytes; int status = 200; QUrl redirect; bool held = false;
  QNetworkReply::NetworkError error = QNetworkReply::NoError; QByteArray contentRange; };
class FixtureReply : public QNetworkReply
{
public:
  FixtureReply(const QNetworkRequest& request, Response response, QObject* parent) : QNetworkReply(parent), m_response(response)
  {
    setRequest(request); setUrl(request.url()); setOperation(QNetworkAccessManager::GetOperation);
    setAttribute(QNetworkRequest::HttpStatusCodeAttribute, response.status);
    if (!response.redirect.isEmpty()) setAttribute(QNetworkRequest::RedirectionTargetAttribute, response.redirect);
    if (!response.contentRange.isEmpty()) setRawHeader("Content-Range", response.contentRange);
    open(QIODevice::ReadOnly | QIODevice::Unbuffered);
    if (!response.held) QTimer::singleShot(0, this, [this] { complete(); });
  }
  void complete()
  {
    if (isFinished()) return;
    emit readyRead();
    if (m_response.error != NoError) setError(m_response.error, "Fixture failure");
    setFinished(true); emit finished();
  }
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
  QList<QByteArray> ranges;
protected:
  QNetworkReply* createRequest(Operation, const QNetworkRequest& request, QIODevice*) override
  {
    requests.append(request.url());
    ranges.append(request.rawHeader("Range"));
    return new FixtureReply(request, responses.isEmpty() ? Response{{}, 503} : responses.takeFirst(), this);
  }
};
static QByteArray metadata()
{
  return R"([{"tag_name":"v2.0.0","draft":false,"prerelease":false,"body":"Notes","assets":[{"name":"TigerestTheater-2.0.0-x64.exe","size":3,"digest":"sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","browser_download_url":"https://github.com/Tigerest/Tigerest-Theater/releases/download/v2.0.0/TigerestTheater-2.0.0-x64.exe"}]}])";
}
static const QUrl packageUrl("https://github.com/Tigerest/Tigerest-Theater/releases/download/v2.0.0/TigerestTheater-2.0.0-x64.exe");
static const QUrl assetUrl("https://release-assets.githubusercontent.com/github-production-release-asset/1/asset");
static QByteArray readPackage(const QString& path)
{
  QFile file(path);
  return file.open(QIODevice::ReadOnly) ? file.readAll() : QByteArray();
}
class TestAppUpdater : public QObject
{
  Q_OBJECT
private slots:
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
  void stalledDownloadResumesFromReleaseUrlWithRange()
  {
    QTemporaryDir dir; FixtureNetwork network;
    const QString stale = dir.filePath("cache/superseded/TigerestTheater-1.9.0-x64.exe.part");
    QVERIFY(QDir().mkpath(QFileInfo(stale).absolutePath()));
    { QFile file(stale); QVERIFY(file.open(QIODevice::WriteOnly)); file.write("old"); }
    network.responses = {{metadata()}, {{}, 302, assetUrl}, {"a", 200, {}, false, QNetworkReply::OperationCanceledError},
      {{}, 302, assetUrl}, {"bc", 206, {}, false, QNetworkReply::NoError, "bytes 1-2/3"}};
    QString launched;
    AppUpdater updater("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, dir.filePath("cache"), dir.filePath("skip.json"), &network,
      [&](const QString& path, AppUpdatePolicy::Package) { launched = path; return true; });
    updater.setRetryDelays({1, 1});
    updater.check(true, true); QTRY_COMPARE(updater.state().value("status").toString(), "available");
    updater.download(); QTRY_COMPARE(updater.state().value("status").toString(), "ready");
    // Every attempt restarts at the release URL; only the resumed one asks for a range.
    QCOMPARE(network.requests.mid(1), (QList<QUrl>{packageUrl, assetUrl, packageUrl, assetUrl}));
    QCOMPARE(network.ranges.mid(1), (QList<QByteArray>{{}, {}, "bytes=1-", "bytes=1-"}));
    QVERIFY(updater.state().value("error").toString().isEmpty());
    QVERIFY(!QFile::exists(stale));
    updater.install(); QCOMPARE(readPackage(launched), QByteArray("abc"));
  }
  void resumeIgnoredOrMisalignedRestartsFromZero()
  {
    QTemporaryDir dir; FixtureNetwork network;
    network.responses = {{metadata()}, {"a", 200, {}, false, QNetworkReply::OperationCanceledError},
      {"abc", 200}, // Range ignored: the full package replaces the prefix.
    };
    QString launched;
    AppUpdater updater("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, dir.filePath("cache"), dir.filePath("skip.json"), &network,
      [&](const QString& path, AppUpdatePolicy::Package) { launched = path; return true; });
    updater.setRetryDelays({1, 1, 1});
    updater.check(true, true); QTRY_COMPARE(updater.state().value("status").toString(), "available");
    updater.download(); QTRY_COMPARE(updater.state().value("status").toString(), "ready");
    QCOMPARE(network.ranges.mid(1), (QList<QByteArray>{{}, "bytes=1-"}));
    updater.install(); QCOMPARE(readPackage(launched), QByteArray("abc"));

    QTemporaryDir second; FixtureNetwork misaligned;
    misaligned.responses = {{metadata()}, {"a", 200, {}, false, QNetworkReply::OperationCanceledError},
      {"bc", 206, {}, false, QNetworkReply::NoError, "bytes 0-1/3"}, {"abc", 200}};
    launched.clear();
    AppUpdater other("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, second.filePath("cache"), second.filePath("skip.json"), &misaligned,
      [&](const QString& path, AppUpdatePolicy::Package) { launched = path; return true; });
    other.setRetryDelays({1, 1, 1});
    other.check(true, true); QTRY_COMPARE(other.state().value("status").toString(), "available");
    other.download(); QTRY_COMPARE(other.state().value("status").toString(), "ready");
    // A mismatched Content-Range is never appended; the next attempt starts clean.
    QCOMPARE(misaligned.ranges.mid(1), (QList<QByteArray>{{}, "bytes=1-", {}}));
    other.install(); QCOMPARE(readPackage(launched), QByteArray("abc"));
  }
  void repeatedFailuresKeepProgressForManualRetry()
  {
    QTemporaryDir dir; FixtureNetwork network;
    network.responses = {{metadata()}, {"a", 200, {}, false, QNetworkReply::OperationCanceledError},
      {{}, 503}, {{}, 503}};
    AppUpdater updater("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, dir.filePath("cache"), dir.filePath("skip.json"), &network, {});
    updater.setRetryDelays({1, 1});
    updater.check(true, true); QTRY_COMPARE(updater.state().value("status").toString(), "available");
    updater.download(); QTRY_COMPARE(updater.state().value("status").toString(), "error");
    // Progress refills the budget, so only the two attempts without bytes are spent.
    QCOMPARE(network.requests.size(), 4);
    QVERIFY(updater.state().value("error").toString().contains("已保留下载进度"));
    network.responses = {{"bc", 206, {}, false, QNetworkReply::NoError, "bytes 1-2/3"}};
    updater.download(); QTRY_COMPARE(updater.state().value("status").toString(), "ready");
    QCOMPARE(network.ranges.last(), QByteArray("bytes=1-"));
  }
  void clientErrorsFailWithoutRetrying()
  {
    QTemporaryDir dir; FixtureNetwork network; network.responses = {{metadata()}, {{}, 404}};
    AppUpdater updater("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, dir.filePath("cache"), dir.filePath("skip.json"), &network, {});
    updater.check(true, true); QTRY_COMPARE(updater.state().value("status").toString(), "available");
    updater.download(); QTRY_COMPARE(updater.state().value("status").toString(), "error");
    QCOMPARE(network.requests.size(), 2);
    QVERIFY(updater.state().value("error").toString().contains("404"));
  }
  void partialPackageSurvivesRestartAndCancel()
  {
    QTemporaryDir dir; FixtureNetwork network;
    network.responses = {{metadata()}, {"a", 200, {}, false, QNetworkReply::OperationCanceledError}};
    {
      AppUpdater updater("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, dir.filePath("cache"), dir.filePath("skip.json"), &network, {});
      updater.check(true, true); QTRY_COMPARE(updater.state().value("status").toString(), "available");
      updater.download(); QTRY_VERIFY(updater.state().value("error").toString().contains("自动继续"));
      QCOMPARE(updater.state().value("status").toString(), "downloading");
      QCOMPARE(updater.state().value("received").toLongLong(), 1);
    } // Closed during the retry wait.
    network.responses = {{metadata()}, {"b", 206, {}, true, QNetworkReply::NoError, "bytes 1-2/3"},
      {"bc", 206, {}, false, QNetworkReply::NoError, "bytes 1-2/3"}};
    AppUpdater updater("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, dir.filePath("cache"), dir.filePath("skip.json"), &network, {});
    updater.check(true, true); QTRY_COMPARE(updater.state().value("status").toString(), "available");
    updater.download();
    QCOMPARE(updater.state().value("received").toLongLong(), 1);
    QCOMPARE(network.ranges.last(), QByteArray("bytes=1-"));
    updater.cancel(); QCOMPARE(updater.state().value("status").toString(), "available");
    updater.download(); QTRY_COMPARE(updater.state().value("status").toString(), "ready");
    QCOMPARE(network.ranges.last(), QByteArray("bytes=1-"));
  }
  void skipDiscardsPartialPackage()
  {
    QTemporaryDir dir; FixtureNetwork network;
    network.responses = {{metadata()}, {"a", 200, {}, false, QNetworkReply::OperationCanceledError}};
    AppUpdater updater("1.0.0", AppUpdatePolicy::Package::WindowsInstaller, dir.filePath("cache"), dir.filePath("skip.json"), &network, {});
    updater.check(true, true); QTRY_COMPARE(updater.state().value("status").toString(), "available");
    updater.download(); QTRY_COMPARE(updater.state().value("received").toLongLong(), 1);
    updater.cancel(); updater.skip();
    QDirIterator parts(dir.filePath("cache"), {"*.part"}, QDir::Files, QDirIterator::Subdirectories);
    QVERIFY(!parts.hasNext());
  }
};
QTEST_GUILESS_MAIN(TestAppUpdater)
#include "test_appupdater.moc"
