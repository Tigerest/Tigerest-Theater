#include "AppUpdatePolicy.h"
#include <QCryptographicHash>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>
#include <QVersionNumber>
#include <cmath>

namespace AppUpdatePolicy
{
namespace {
const QRegularExpression MirrorMarker("<!--\\s*tigerest-mirrors\\s+(\\{[^<>]*\\})\\s*-->");
QUrl mirror(const QJsonObject& links, const QString& key, const QString& pattern, const char* fallback)
{
  const QString url = links.value(key).toString();
  return QUrl(QRegularExpression(pattern).match(url).hasMatch() ? url : QString::fromLatin1(fallback));
}
// MAJOR.MINOR.PATCH, plus a fourth number (1-99) for a fix release such as 2.9.5.1.
// A missing fourth number is 0, so 2.9.5 sorts before 2.9.5.1.
const QString VersionPattern("(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})(?:\\.([1-9][0-9]?))?");
QVersionNumber versionOf(const QRegularExpressionMatch& match)
{
  return QVersionNumber({match.captured(1).toInt(), match.captured(2).toInt(), match.captured(3).toInt(), match.captured(4).toInt()});
}
}

QList<QUrl> downloadSources(const Candidate& candidate)
{
  return DownloadProxies::sources(candidate.downloadUrl);
}

Candidate select(const QJsonArray& releases, const QString& currentVersion, Package package)
{
  const QRegularExpression currentPattern("^v?" + VersionPattern + "(-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$");
  const QRegularExpression stablePattern("^v" + VersionPattern + "$");
  const auto currentMatch = currentPattern.match(currentVersion);
  if (!currentMatch.hasMatch()) return {};
  const QVersionNumber current = versionOf(currentMatch);
  const QString suffix = package == Package::WindowsInstaller ? "x64.exe" :
    package == Package::WindowsPortable ? "x64.zip" : package == Package::MacArm64 ? "arm64.dmg" : QString();
  if (suffix.isEmpty()) return {};
  Candidate best;
  QVersionNumber bestVersion;
  for (const auto& value : releases)
  {
    const auto release = value.toObject();
    if (!release.value("draft").isBool() || release.value("draft").toBool() ||
        !release.value("prerelease").isBool() || release.value("prerelease").toBool()) continue;
    const QString tag = release.value("tag_name").toString();
    const auto match = stablePattern.match(tag);
    if (!match.hasMatch()) continue;
    const QVersionNumber version = versionOf(match);
    if (version < current || (version == current && currentMatch.captured(5).isEmpty()) ||
        (!bestVersion.isNull() && version <= bestVersion)) continue;
    const QString name = "TigerestTheater-" + tag.mid(1) + "-" + suffix;
    const QString download = "https://github.com/Tigerest/Tigerest-Theater/releases/download/" + tag + "/" + name;
    for (const auto& item : release.value("assets").toArray())
    {
      const auto asset = item.toObject();
      const QString digest = asset.value("digest").toString();
      const double size = asset.value("size").toDouble(-1);
      if (asset.value("name").toString() != name || asset.value("browser_download_url").toString() != download ||
          size <= 0 || size > MaximumPackageBytes || std::floor(size) != size ||
          !QRegularExpression("^sha256:[0-9a-fA-F]{64}$").match(digest).hasMatch()) continue;
      QString body = release.value("body").toString();
      const auto marker = MirrorMarker.match(body);
      const auto links = QJsonDocument::fromJson(marker.captured(1).toUtf8()).object();
      body.remove(MirrorMarker);
      best = {tag.mid(1), name, body.trimmed().left(20000),
        QUrl("https://github.com/Tigerest/Tigerest-Theater/releases/tag/" + tag),
        QUrl(download), QByteArray::fromHex(digest.mid(7).toLatin1()), static_cast<qint64>(size),
        mirror(links, "quark", "^https://pan\\.quark\\.cn/s/[0-9A-Za-z]{6,64}(\\?pwd=[0-9A-Za-z]{4})?$", DefaultQuarkShare),
        mirror(links, "baidu", "^https://pan\\.baidu\\.com/s/[0-9A-Za-z_-]{6,64}(\\?pwd=[0-9A-Za-z]{4})?$", DefaultBaiduShare)};
      bestVersion = version;
      break;
    }
  }
  return best;
}

QJsonObject cachedRelease(const QJsonArray& releases, const Candidate& candidate)
{
  for (const auto& value : releases)
  {
    auto release = value.toObject();
    if (!candidate.valid() || release.value("tag_name").toString() != "v" + candidate.version) continue;
    QJsonArray assets;
    for (const auto& asset : release.value("assets").toArray())
      if (asset.toObject().value("name").toString() == candidate.fileName) assets.append(asset);
    return {{"draft", release.value("draft")}, {"prerelease", release.value("prerelease")},
      {"tag_name", release.value("tag_name")}, {"body", release.value("body").toString().left(40000)}, {"assets", assets}};
  }
  return {};
}

bool verifyFile(const QString& path, const Candidate& candidate)
{
  if (!candidate.valid() || candidate.sha256.size() != 32 || candidate.size <= 0 ||
      candidate.size > MaximumPackageBytes || QFileInfo(path).isSymLink()) return false;
  QFile file(path);
  if (!file.open(QIODevice::ReadOnly) || file.size() != candidate.size) return false;
  QCryptographicHash hash(QCryptographicHash::Sha256);
  return hash.addData(&file) && hash.result() == candidate.sha256;
}
}
