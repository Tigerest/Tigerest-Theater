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
  void releaseManifestStandsInForTheApiRelease()
  {
    const QString hash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    QJsonObject manifest{{"version", "2.1.0"}, {"files", QJsonArray{
      QJsonObject{{"name", "TigerestTheater-2.1.0-x64.zip"}, {"size", 5}, {"sha256", QString(64, 'a')}},
      QJsonObject{{"name", "TigerestTheater-2.1.0-x64.exe"}, {"size", 3}, {"sha256", hash}}}}};
    const auto c = select(manifestRelease(manifest, "v2.1.0", Package::WindowsInstaller), "2.0.0", Package::WindowsInstaller);
    QCOMPARE(c.fileName, "TigerestTheater-2.1.0-x64.exe");
    QCOMPARE(c.size, 3);
    QCOMPARE(QString::fromLatin1(c.sha256.toHex()), hash);
    QCOMPARE(c.downloadUrl, QUrl("https://github.com/Tigerest/Tigerest-Theater/releases/download/v2.1.0/TigerestTheater-2.1.0-x64.exe"));
    QCOMPARE(c.releaseUrl, QUrl("https://github.com/Tigerest/Tigerest-Theater/releases/tag/v2.1.0"));
    QVERIFY(!select(manifestRelease(manifest, "v2.1.0", Package::WindowsInstaller), "2.1.0", Package::WindowsInstaller).valid());
    QVERIFY(manifestRelease(manifest, "v2.2.0", Package::WindowsInstaller).isEmpty());
    QVERIFY(manifestRelease(manifest, "v2.1.0", Package::MacArm64).isEmpty());
    QVERIFY(manifestRelease(manifest, "v2.1.0", Package::Unsupported).isEmpty());
    manifest["files"] = QJsonArray{QJsonObject{{"name", "TigerestTheater-2.1.0-x64.exe"}, {"size", MaximumPackageBytes + 1}, {"sha256", hash}}};
    QVERIFY(!select(manifestRelease(manifest, "v2.1.0", Package::WindowsInstaller), "2.0.0", Package::WindowsInstaller).valid());
    QCOMPARE(manifestName("v2.1.0", Package::WindowsPortable), "TigerestTheater-2.1.0-RELEASE-MANIFEST.json");
    QCOMPARE(manifestName("v2.1.0", Package::MacArm64), "TigerestTheater-2.1.0-APPLE-RELEASE-MANIFEST.json");
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
