#include "ReleaseFeed.h"
#include "Ed25519.h"

#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>

namespace
{
constexpr qint64 ClockSkewSeconds = 10 * 60;
constexpr qint64 StaleAfterSeconds = 72 * 3600;

std::optional<QJsonArray> reject(QString* reason, const QString& why)
{
  if (reason) *reason = why;
  return std::nullopt;
}

QByteArray strictBase64(const QJsonValue& value)
{
  if (!value.isString()) return {};
  const auto decoded = QByteArray::fromBase64Encoding(value.toString().toLatin1(), QByteArray::AbortOnBase64DecodingErrors);
  return decoded ? *decoded : QByteArray();
}

QDateTime timestamp(const QJsonValue& value)
{
  static const QRegularExpression format("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$");
  if (!value.isString() || !format.match(value.toString()).hasMatch()) return {};
  return QDateTime::fromString(value.toString(), Qt::ISODate);
}
}

QUrl ReleaseFeed::address()
{
  return QUrl("https://nas.tigerest.top:18446/api/tigerest/v1/app/releases");
}

ReleaseFeed::Keys ReleaseFeed::productionKeys()
{
  return {{"tg-release-1", QByteArray::fromBase64("zIJjQTCdN1PbiNIUyVNJmPZys/Pdar/YRvzKYd/knBA=")}};
}

std::optional<QJsonArray> ReleaseFeed::open(const QByteArray& envelope, const QDateTime& now, const Keys& keys, QString* reason)
{
  if (envelope.size() > MaximumEnvelopeBytes) return reject(reason, "envelope over 2 MiB");
  const auto outer = QJsonDocument::fromJson(envelope).object();
  const QByteArray publicKey = keys.value(outer.value("keyId").toString());
  if (publicKey.isEmpty()) return reject(reason, "unknown keyId");
  const QByteArray payload = strictBase64(outer.value("payload"));
  const QByteArray signature = strictBase64(outer.value("signature"));
  if (payload.isEmpty() || signature.isEmpty()) return reject(reason, "payload or signature missing or not base64");
  if (payload.size() > MaximumPayloadBytes) return reject(reason, "payload over 1 MiB");
  if (!Ed25519::verify(signature, payload, publicKey)) return reject(reason, "bad signature");
  QJsonParseError error;
  const auto document = QJsonDocument::fromJson(payload, &error);
  if (error.error != QJsonParseError::NoError || !document.isObject()) return reject(reason, "payload is not an object");
  const auto feed = document.object();
  if (feed.value("schema") != QJsonValue(1) || feed.value("repository") != QJsonValue("Tigerest/Tigerest-Theater"))
    return reject(reason, "unexpected schema or repository");
  const QDateTime issued = timestamp(feed.value("issuedAt")), fetched = timestamp(feed.value("fetchedAt"));
  if (!issued.isValid() || !fetched.isValid()) return reject(reason, "bad timestamps");
  if (fetched > issued) return reject(reason, "fetchedAt after issuedAt");
  if (issued > now.addSecs(ClockSkewSeconds)) return reject(reason, "issuedAt in the future");
  if (fetched < now.addSecs(-StaleAfterSeconds)) return reject(reason, "release list older than 72 hours");
  if (!feed.value("releases").isArray()) return reject(reason, "releases missing");
  return feed.value("releases").toArray();
}
