#include <QtTest>
#include <QJsonObject>
#include <QTemporaryDir>
#include <QFile>
#include "system/AppUpdatePolicy.h"

using namespace AppUpdatePolicy;
static QJsonObject release(const QString& version, const QString& suffix = "x64.exe")
{
  const QString name = "TigerestTheater-" + version + "-" + suffix;
  return {{"tag_name", "v" + version}, {"draft", false}, {"prerelease", false},
    {"body", "Release notes <script>alert(1)</script>"},
    {"assets", QJsonArray{QJsonObject{{"name", name}, {"size", 3},
      {"digest", "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"},
      {"browser_download_url", "https://github.com/Tigerest/Tigerest-Theater/releases/download/v" + version + "/" + name}}}}};
}
static QJsonObject assetChanged(QJsonObject value, const QString& key, const QJsonValue& replacement)
{
  auto assets = value["assets"].toArray();
  auto asset = assets[0].toObject();
  asset[key] = replacement;
  assets[0] = asset;
  value["assets"] = assets;
  return value;
}

class TestAppUpdatePolicy : public QObject
{
  Q_OBJECT
private slots:
  void selectsHighestStableNumerically()
  {
    auto draft = release("4.0.0"); draft["draft"] = true;
    auto prerelease = release("5.0.0"); prerelease["prerelease"] = true;
    const auto c = select({release("2.9.0"), draft, prerelease, release("2.10.0"), release("3.0.0-dev")}, "2.8.0", Package::WindowsInstaller);
    QCOMPARE(c.version, "2.10.0");
    QCOMPARE(c.releaseUrl, QUrl("https://github.com/Tigerest/Tigerest-Theater/releases/tag/v2.10.0"));
    QCOMPARE(c.notes, "Release notes <script>alert(1)</script>"); // Text, never interpreted HTML.
  }
  void prereleaseCanUpgradeToSameStableButNeverDowngrade()
  {
    QVERIFY(select({release("2.0.0")}, "2.0.0-dev", Package::WindowsInstaller).valid());
    QVERIFY(!select({release("2.0.0")}, "2.0.0", Package::WindowsInstaller).valid());
    QVERIFY(!select({release("1.9.0")}, "2.0.0-dev", Package::WindowsInstaller).valid());
    QVERIFY(!select({release("2.0.0")}, "unknown", Package::WindowsInstaller).valid());
  }
  void readsFixReleases()
  {
    // A fourth number marks a fix release; 2.9.5 and 2.9.5.0 are the same version.
    const auto fix = select({release("2.9.5"), release("2.9.5.1"), release("2.9.4.9")}, "2.9.5", Package::WindowsInstaller);
    QCOMPARE(fix.version, "2.9.5.1");
    QCOMPARE(fix.fileName, "TigerestTheater-2.9.5.1-x64.exe");
    QCOMPARE(select({release("2.9.5.2"), release("2.9.5.10"), release("2.9.6")}, "2.9.5.1", Package::WindowsInstaller).version, "2.9.6");
    QCOMPARE(select({release("2.9.5.2"), release("2.9.5.10")}, "2.9.5.1", Package::WindowsInstaller).version, "2.9.5.10");
    QVERIFY(!select({release("2.9.5"), release("2.9.5.1")}, "2.9.5.1", Package::WindowsInstaller).valid());
    QVERIFY(select({release("2.9.5.1")}, "2.9.5.1-dev", Package::WindowsInstaller).valid());
    for (const char* bad : {"2.9.5.0", "2.9.5.100", "2.9.5.01", "2.9.5.1.1"})
      QVERIFY2(!select({release(bad)}, "2.9.5", Package::WindowsInstaller).valid(), bad);
    // A fix published for another platform only is not offered here.
    QVERIFY(!select({release("2.9.5.1", "android.apk")}, "2.9.5", Package::WindowsInstaller).valid());
  }
  void choosesExactPlatformPackage()
  {
    QJsonArray versions{release("2.0.0"), release("2.1.0", "arm64.dmg"), release("2.2.0", "x64.zip"), release("2.3.0", "arm64.apk")};
    QCOMPARE(select(versions, "1.0.0", Package::WindowsInstaller).fileName, "TigerestTheater-2.0.0-x64.exe");
    QCOMPARE(select(versions, "1.0.0", Package::WindowsPortable).version, "2.2.0");
    QCOMPARE(select(versions, "1.0.0", Package::MacArm64).version, "2.1.0");
    QVERIFY(!select(versions, "1.0.0", Package::Unsupported).valid());
  }
  void rejectsUntrustedOrUnboundedAssets_data()
  {
    QTest::addColumn<QString>("key"); QTest::addColumn<QJsonValue>("value");
    QTest::newRow("no hash") << "digest" << QJsonValue(QJsonValue::Null);
    QTest::newRow("short hash") << "digest" << QJsonValue("sha256:abc");
    QTest::newRow("wrong algorithm") << "digest" << QJsonValue("sha512:" + QString(64, 'a'));
    QTest::newRow("zero size") << "size" << QJsonValue(0);
    QTest::newRow("negative size") << "size" << QJsonValue(-1);
    QTest::newRow("oversize") << "size" << QJsonValue(2147483649.0);
    QTest::newRow("fractional size") << "size" << QJsonValue(3.5);
    QTest::newRow("path injection") << "name" << QJsonValue("../TigerestTheater-2.0.0-x64.exe");
    QTest::newRow("http") << "browser_download_url" << QJsonValue("http://github.com/Tigerest/Tigerest-Theater/releases/download/v2.0.0/TigerestTheater-2.0.0-x64.exe");
    QTest::newRow("wrong repo") << "browser_download_url" << QJsonValue("https://github.com/attacker/Tigerest-Theater/releases/download/v2.0.0/TigerestTheater-2.0.0-x64.exe");
    QTest::newRow("query") << "browser_download_url" << QJsonValue("https://github.com/Tigerest/Tigerest-Theater/releases/download/v2.0.0/TigerestTheater-2.0.0-x64.exe?redirect=1");
    QTest::newRow("credentials") << "browser_download_url" << QJsonValue("https://user@github.com/Tigerest/Tigerest-Theater/releases/download/v2.0.0/TigerestTheater-2.0.0-x64.exe");
  }
  void rejectsUntrustedOrUnboundedAssets()
  {
    QFETCH(QString, key); QFETCH(QJsonValue, value);
    QVERIFY(!select({assetChanged(release("2.0.0"), key, value)}, "1.0.0", Package::WindowsInstaller).valid());
  }
  void readsNetdiskMirrorsFromReleaseNotes()
  {
    auto value = release("2.0.0");
    value["body"] = R"(Notes
<!-- tigerest-mirrors {"quark":"https://pan.quark.cn/s/abc123def","baidu":"https://pan.baidu.com/s/1AbC-d_E?pwd=x7k2"} -->)";
    const auto c = select({value}, "1.0.0", Package::WindowsInstaller);
    QCOMPARE(c.notes, "Notes");
    QCOMPARE(c.quarkUrl, QUrl("https://pan.quark.cn/s/abc123def"));
    QCOMPARE(c.baiduUrl, QUrl("https://pan.baidu.com/s/1AbC-d_E?pwd=x7k2"));
    // The remembered form selects the same package again.
    const auto cached = cachedRelease({release("1.5.0"), value}, c);
    const auto again = select({cached}, "1.0.0", Package::WindowsInstaller);
    QCOMPARE(again.downloadUrl, c.downloadUrl); QCOMPARE(again.sha256, c.sha256); QCOMPARE(again.baiduUrl, c.baiduUrl);
    QVERIFY(!select({cached}, "2.0.0", Package::WindowsInstaller).valid());
    value["body"] = R"(<!-- tigerest-mirrors {"quark":"https://evil.example/s/abc123def","baidu":"http://pan.baidu.com/s/1AbCdEf"} -->)";
    const auto untrusted = select({value}, "1.0.0", Package::WindowsInstaller);
    QVERIFY(untrusted.valid()); QVERIFY(untrusted.notes.isEmpty());
    QCOMPARE(untrusted.quarkUrl, QUrl(DefaultQuarkShare)); QCOMPARE(untrusted.baiduUrl, QUrl(DefaultBaiduShare));
  }
  void usesBuiltInNetdiskSharesWithoutAMarker()
  {
    const auto c = select({release("2.0.0")}, "1.0.0", Package::WindowsInstaller);
    QCOMPARE(c.quarkUrl, QUrl("https://pan.quark.cn/s/88e6f7a795b4"));
    QCOMPARE(c.baiduUrl, QUrl("https://pan.baidu.com/s/58azzOU4piiB3miyZqA1dig"));
  }
  void triesTheDownloadProxiesBeforeTheReleaseUrl()
  {
    const auto c = select({release("2.0.0")}, "1.0.0", Package::WindowsInstaller);
    QCOMPARE(downloadSources(c), (QList<QUrl>{QUrl("https://gh-proxy.com/" + c.downloadUrl.toString()),
      QUrl("https://ghproxy.net/" + c.downloadUrl.toString()), c.downloadUrl}));
    QCOMPARE(downloadSources(c).value(DownloadProxyCount), c.downloadUrl);
    // Only github.com downloads go through the accelerators.
    QCOMPARE(DownloadProxies::sources(QUrl("https://example.com/a.zip")), QList<QUrl>{QUrl("https://example.com/a.zip")});
    QCOMPARE(DownloadProxies::sources(QUrl("http://github.com/a.zip")), QList<QUrl>{QUrl("http://github.com/a.zip")});
  }
  void verifiesDownloadedBytesAndSize()
  {
    QTemporaryDir dir;
    const QString path = dir.filePath("package.exe");
    QFile file(path); QVERIFY(file.open(QIODevice::WriteOnly)); file.write("abc"); file.close();
    auto c = select({release("2.0.0")}, "1.0.0", Package::WindowsInstaller);
    QVERIFY(verifyFile(path, c));
    QVERIFY(file.open(QIODevice::WriteOnly)); file.write("abd"); file.close();
    QVERIFY(!verifyFile(path, c));
    QVERIFY(file.open(QIODevice::WriteOnly)); file.write("abcd"); file.close();
    QVERIFY(!verifyFile(path, c));
  }
};
QTEST_GUILESS_MAIN(TestAppUpdatePolicy)
#include "test_appupdate_policy.moc"
