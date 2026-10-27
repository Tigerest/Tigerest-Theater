#include <QtTest>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include "system/Ed25519.h"
#include "system/ReleaseFeed.h"

// Vectors and envelopes come from fixtures/make_release_feed_cases.mjs (Node's own Ed25519 signer,
// checked there against RFC 8032); the production envelope is a real response of the deployed feed.
static QJsonObject cases()
{
  QFile file(FIXTURES "/release_feed_cases.json");
  if (!file.open(QIODevice::ReadOnly)) qFatal("release_feed_cases.json missing");
  return QJsonDocument::fromJson(file.readAll()).object();
}
static QDateTime at(const QString& text) { return QDateTime::fromString(text, Qt::ISODate); }

class TestReleaseFeed : public QObject
{
  Q_OBJECT
private slots:
  void ed25519_data()
  {
    QTest::addColumn<QByteArray>("publicKey");
    QTest::addColumn<QByteArray>("message");
    QTest::addColumn<QByteArray>("signature");
    QTest::addColumn<bool>("valid");
    for (const auto& value : cases().value("ed25519").toArray())
    {
      const auto vector = value.toObject();
      QTest::newRow(vector.value("name").toString().toUtf8().constData())
        << QByteArray::fromHex(vector.value("publicKey").toString().toLatin1()) << QByteArray::fromHex(vector.value("message").toString().toLatin1())
        << QByteArray::fromHex(vector.value("signature").toString().toLatin1()) << vector.value("valid").toBool();
    }
  }
  void ed25519()
  {
    QFETCH(QByteArray, publicKey); QFETCH(QByteArray, message); QFETCH(QByteArray, signature); QFETCH(bool, valid);
    QCOMPARE(Ed25519::verify(signature, message, publicKey), valid);
  }
  void ed25519RejectsMalformedInput()
  {
    const auto vector = cases().value("ed25519").toArray().first().toObject();
    const auto key = QByteArray::fromHex(vector.value("publicKey").toString().toLatin1());
    const auto signature = QByteArray::fromHex(vector.value("signature").toString().toLatin1());
    QVERIFY(Ed25519::verify(signature, {}, key));
    QVERIFY(!Ed25519::verify(signature.left(63), {}, key));
    QVERIFY(!Ed25519::verify(signature, {}, key.left(31)));
    // y = 2 has no x on the curve, so it is not a public key.
    QVERIFY(!Ed25519::verify(signature, {}, QByteArray(1, '\2') + QByteArray(31, '\0')));
  }

  void envelopes_data()
  {
    QTest::addColumn<QByteArray>("envelope");
    QTest::addColumn<QString>("reason");
    for (const auto& value : cases().value("envelopes").toArray())
    {
      const auto envelope = value.toObject();
      QTest::newRow(envelope.value("name").toString().toUtf8().constData())
        << envelope.value("envelope").toString().toUtf8() << envelope.value("reason").toString();
    }
  }
  void envelopes()
  {
    QFETCH(QByteArray, envelope); QFETCH(QString, reason);
    const auto fixture = cases();
    const ReleaseFeed::Keys keys{{fixture.value("keyId").toString(), QByteArray::fromBase64(fixture.value("publicKey").toString().toLatin1())}};
    QString why;
    const auto releases = ReleaseFeed::open(envelope, at(fixture.value("now").toString()), keys, &why);
    QCOMPARE(why, reason);
    QCOMPARE(releases.has_value(), reason.isEmpty());
    if (releases) QCOMPARE(releases->first().toObject().value("tag_name").toString(), "v2.0.0");
  }
  void sizeLimitsComeBeforeAnythingElse()
  {
    const auto fixture = cases();
    const ReleaseFeed::Keys keys{{"test-1", QByteArray::fromBase64(fixture.value("publicKey").toString().toLatin1())}};
    QString why;
    QVERIFY(!ReleaseFeed::open(QByteArray(ReleaseFeed::MaximumEnvelopeBytes + 1, ' '), {}, keys, &why));
    QCOMPARE(why, "envelope over 2 MiB");
    const QByteArray payload = QByteArray(ReleaseFeed::MaximumPayloadBytes + 1, ' ').toBase64();
    const QByteArray envelope = QJsonDocument(QJsonObject{{"keyId", "test-1"}, {"payload", QString::fromLatin1(payload)},
      {"signature", QString::fromLatin1(QByteArray(64, '\0').toBase64())}}).toJson();
    QVERIFY(!ReleaseFeed::open(envelope, {}, keys, &why));
    QCOMPARE(why, "payload over 1 MiB");
  }

  void productionResponseVerifiesWithTheBuiltInKey()
  {
    QFile file(FIXTURES "/release_feed_production.json");
    QVERIFY(file.open(QIODevice::ReadOnly));
    const QByteArray envelope = file.readAll();
    QString why;
    const auto releases = ReleaseFeed::open(envelope, at("2026-10-21T10:53:13Z"), ReleaseFeed::productionKeys(), &why);
    QVERIFY2(releases, qPrintable(why));
    QCOMPARE(releases->size(), 30);
    QCOMPARE(releases->first().toObject().value("tag_name").toString(), "v2.9.3");
    // The same response three days later is stale, and a single changed byte breaks the signature.
    QVERIFY(!ReleaseFeed::open(envelope, at("2026-10-24T10:52:14Z"), ReleaseFeed::productionKeys(), &why));
    QCOMPARE(why, "release list older than 72 hours");
    auto outer = QJsonDocument::fromJson(envelope).object();
    QByteArray payload = QByteArray::fromBase64(outer.value("payload").toString().toLatin1());
    payload[payload.indexOf("v2.9.3") + 5] = '4';
    outer["payload"] = QString::fromLatin1(payload.toBase64());
    QVERIFY(!ReleaseFeed::open(QJsonDocument(outer).toJson(), at("2026-10-21T10:53:13Z"), ReleaseFeed::productionKeys(), &why));
    QCOMPARE(why, "bad signature");
  }
  void publicAddressIsHttps()
  {
    QCOMPARE(ReleaseFeed::address(), QUrl("https://nas.tigerest.top:18446/api/tigerest/v1/app/releases"));
  }
  void liveFeedVerifies()
  {
    // Reads the deployed feed (GET only) and checks it with the built-in key and the real clock.
    if (!qEnvironmentVariableIsSet("TIGEREST_LIVE_FEED")) QSKIP("TIGEREST_LIVE_FEED is not set");
    QNetworkAccessManager network;
    QNetworkRequest request(ReleaseFeed::address());
    request.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::ManualRedirectPolicy);
    std::unique_ptr<QNetworkReply> reply(network.get(request));
    QTRY_VERIFY_WITH_TIMEOUT(reply->isFinished(), 20000);
    QCOMPARE(reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(), 200);
    QString why;
    const auto releases = ReleaseFeed::open(reply->readAll(), QDateTime::currentDateTimeUtc(), ReleaseFeed::productionKeys(), &why);
    QVERIFY2(releases, qPrintable(why));
    QVERIFY(!releases->isEmpty());
    qInfo() << "live feed:" << releases->size() << "releases, newest" << releases->first().toObject().value("tag_name").toString();
  }
};

QTEST_GUILESS_MAIN(TestReleaseFeed)
#include "test_release_feed.moc"
