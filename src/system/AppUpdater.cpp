#include "AppUpdater.h"
#include <QDir>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>
#include <QSaveFile>
#include <QTimer>

using AppUpdatePolicy::Package;

namespace {
constexpr int RetryDelays[] = {2000, 5000, 10000, 20000, 30000};
constexpr int RetryLimit = sizeof(RetryDelays) / sizeof(RetryDelays[0]);
constexpr auto RateLimited = "GitHub 请求受限，请稍后重试。";
bool plainPath(const QString& path)
{
  const QFileInfo info(path);
  return !info.isSymLink() && !info.isJunction();
}
bool strongEtag(const QByteArray& value)
{
  if (value.size() < 2 || value.size() > 512 || !value.startsWith('"') || !value.endsWith('"')) return false;
  for (int i = 1; i < value.size() - 1; ++i)
    if (static_cast<unsigned char>(value[i]) < 33 || value[i] == '"' || value[i] == 127) return false;
  return true;
}
QString candidateDirectory(const QString& root, const AppUpdatePolicy::Candidate& candidate)
{
  return root + "/" + QString::fromLatin1(candidate.sha256.toHex());
}
}

AppUpdater::AppUpdater(const QString& version, Package package, const QString& cacheDirectory,
                       const QString& preferencePath, QNetworkAccessManager* network, Launcher launcher, QObject* parent)
  : QObject(parent), m_currentVersion(version), m_package(package), m_cacheDirectory(cacheDirectory),
    m_preferencePath(preferencePath), m_network(network), m_launcher(std::move(launcher))
{
  m_state = {{"status", "idle"}, {"currentVersion", version}, {"version", ""},
    {"releaseUrl", "https://github.com/Tigerest/Tigerest-Theater/releases"}, {"notes", ""},
    {"size", qint64(0)}, {"received", qint64(0)}, {"error", ""}, {"manual", false}, {"deferred", false}, {"installAfterDownload", false},
    {"resumable", false}, {"retrying", false}, {"retryAttempt", 0}, {"retryLimit", RetryLimit}, {"retryDelay", 0}, {"speed", qint64(0)},
    {"platform", package == Package::MacArm64 ? "macos" : package == Package::Unsupported ? "unsupported" : "windows"},
    {"installLabel", package == Package::WindowsInstaller ? "安装更新" : package == Package::WindowsPortable ? "打开 ZIP 更新包" : "打开 DMG 更新包"}};
  m_retryTimer.setSingleShot(true);
  connect(&m_retryTimer, &QTimer::timeout, this, &AppUpdater::beginDownloadRequest);
}

AppUpdater::~AppUpdater()
{
  // Keep verified packages and resumable data across application restarts.
  clearTransfer();
}

QVariantMap AppUpdater::state() const { return m_state; }

void AppUpdater::publish(const QString& status, const QString& error)
{
  m_state["status"] = status;
  m_state["error"] = error;
  m_state["version"] = m_candidate.version;
  m_state["notes"] = m_candidate.notes;
  m_state["size"] = m_candidate.size;
  m_state["releaseUrl"] = m_candidate.valid() ? m_candidate.releaseUrl.toString() :
    QString("https://github.com/Tigerest/Tigerest-Theater/releases");
  emit changed(m_state);
}

void AppUpdater::clearTransfer(bool discard)
{
  m_retryTimer.stop();
  if (m_reply)
  {
    auto* reply = m_reply.data();
    m_reply.clear();
    disconnect(reply, nullptr, this, nullptr);
    reply->abort();
    reply->deleteLater();
  }
  if (m_file.isOpen())
  {
    m_state["received"] = m_file.size();
    if (!m_file.flush()) discard = true;
    m_file.close();
  }
  if (discard && m_cacheLock)
  {
    for (const auto& path : {m_file.fileName(), m_metadataPath, m_readyPath})
      if (!path.isEmpty() && plainPath(path)) QFile::remove(path);
    m_state["received"] = qint64(0);
  }
  m_state["resumable"] = !discard && strongEtag(m_etag) && m_state.value("received").toLongLong() > 0;
  m_state["retrying"] = false;
  m_state["speed"] = qint64(0);
  m_cacheLock.reset();
  m_file.setFileName(QString());
  m_readyPath.clear();
  m_downloadDirectory.clear();
  m_metadataPath.clear();
  m_etag.clear();
  m_packageOpened = false;
  m_metadata.clear();
  m_state["installAfterDownload"] = false;
}

void AppUpdater::check(bool manual, bool enabled)
{
  if (!manual)
  {
    if (m_automaticAttempted) return;
    m_automaticAttempted = true;
    if (!enabled) return;
  }
  // A manual check can race the document's startup hook. It already satisfies
  // this process's automatic check and must retain its explicit result UI.
  if (manual) m_automaticAttempted = true;
  m_state["manual"] = manual;
  if (manual) m_state["deferred"] = false;
  const QString status = m_state.value("status").toString();
  if (status == "checking" || status == "downloading" || status == "ready" || status == "installing")
  {
    emit changed(m_state);
    return;
  }
  clearTransfer();
  m_state["received"] = qint64(0);
  m_state["resumable"] = false;
  m_candidate = {};
  if (m_package == Package::Unsupported)
  {
    publish("error", "此平台暂不支持应用内更新，请在发行页面查看可用版本。");
    return;
  }
  publish("checking");
  if (m_state.value("status") != "checking") return;
  m_source = Source::Api;
  request(QUrl("https://api.github.com/repos/Tigerest/Tigerest-Theater/releases?per_page=30"), true);
}

void AppUpdater::request(const QUrl& url, bool metadata, int redirects)
{
  QNetworkRequest request(url);
  request.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::ManualRedirectPolicy);
  request.setHeader(QNetworkRequest::UserAgentHeader, "Tigerest-Theater-Updater/" + m_currentVersion);
  const bool api = metadata && m_source == Source::Api;
  request.setRawHeader("Accept", api ? "application/vnd.github+json" : "application/octet-stream");
  request.setRawHeader("Accept-Encoding", "identity");
  if (api) request.setRawHeader("X-GitHub-Api-Version", "2022-11-28");
  if (!metadata && m_requestOffset > 0)
  {
    request.setRawHeader("Range", "bytes=" + QByteArray::number(m_requestOffset) + "-");
    request.setRawHeader("If-Range", m_etag);
  }
  request.setTransferTimeout(30000);
  auto* reply = m_network->get(request);
  m_reply = reply;
  reply->setReadBufferSize(128 * 1024);
  connect(reply, &QIODevice::readyRead, this, [this, reply, metadata] { receive(reply, metadata); });
  connect(reply, &QNetworkReply::finished, this, [this, reply, metadata, redirects] { finish(reply, metadata, redirects); });
  // Slow downloads may keep making progress indefinitely. Only metadata has
  // an overall deadline; package transfers use the inactivity timeout above.
  if (metadata) QTimer::singleShot(30000, reply, [this, reply] {
    if (m_reply == reply) fail("检查更新超时，请稍后重试。");
  });
}

void AppUpdater::receive(QNetworkReply* reply, bool metadata)
{
  if (m_reply != reply) return;
  if (metadata && reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt() != 200) return;
  if (!metadata && !acceptDownloadHeaders(reply)) return;
  const qint64 maximum = metadata ? AppUpdatePolicy::MaximumMetadataBytes : m_candidate.size;
  bool hasLength = false;
  const qint64 contentLength = reply->header(QNetworkRequest::ContentLengthHeader).toLongLong(&hasLength);
  const qint64 responseSize = metadata ? maximum : maximum - m_requestOffset;
  if (hasLength && (contentLength < 0 || contentLength > responseSize || (!metadata && contentLength != responseSize)))
  {
    fail("更新响应大小不符合预期。", !metadata);
    return;
  }
  while (reply->bytesAvailable() > 0)
  {
    const QByteArray bytes = reply->read(64 * 1024);
    if (bytes.isEmpty()) break;
    const qint64 received = metadata ? m_metadata.size() : m_file.size();
    if (bytes.size() > maximum - received)
    {
      fail("更新响应超过允许的大小。", !metadata);
      return;
    }
    if (metadata) m_metadata.append(bytes);
    else
    {
      if (m_file.write(bytes) != bytes.size())
      {
        fail("无法写入更新文件，请检查可用空间和目录权限。", true);
        return;
      }
      m_state["received"] = m_file.size();
      m_state["resumable"] = strongEtag(m_etag);
      m_state["speed"] = (m_file.size() - m_requestOffset) * 1000 / qMax<qint64>(1, m_transferClock.elapsed());
    }
  }
  if (!metadata && (!m_progressClock.isValid() || m_progressClock.elapsed() >= 100))
  { m_progressClock.start(); emit changed(m_state); }
}

bool AppUpdater::saveDownloadMetadata()
{
  if (!strongEtag(m_etag))
  { QFile::remove(m_metadataPath); return true; }
  QSaveFile file(m_metadataPath); file.setDirectWriteFallback(false);
  const auto bytes = QJsonDocument(QJsonObject{{"schemaVersion", 1}, {"url", m_candidate.downloadUrl.toString()},
    {"sha256", QString::fromLatin1(m_candidate.sha256.toHex())}, {"size", m_candidate.size},
    {"etag", QString::fromLatin1(m_etag)}}).toJson();
  return file.open(QIODevice::WriteOnly) && file.write(bytes) == bytes.size() && file.commit();
}

bool AppUpdater::restoreDownloadMetadata()
{
  m_etag.clear();
  if (!plainPath(m_metadataPath)) return false;
  QFile file(m_metadataPath);
  if (!file.open(QIODevice::ReadOnly) || file.size() > 16 * 1024) return false;
  const auto meta = QJsonDocument::fromJson(file.readAll()).object();
  const auto etag = meta.value("etag").toString().toLatin1();
  if (meta.value("schemaVersion").toInt() != 1 || meta.value("url").toString() != m_candidate.downloadUrl.toString() ||
      meta.value("size").toInteger() != m_candidate.size ||
      meta.value("sha256").toString() != QString::fromLatin1(m_candidate.sha256.toHex()) || !strongEtag(etag)) return false;
  m_etag = etag;
  return true;
}

void AppUpdater::refreshCachedProgress()
{
  m_state["received"] = qint64(0); m_state["resumable"] = false;
  if (!m_candidate.valid() || !plainPath(m_cacheDirectory)) return;
  const auto directory = candidateDirectory(m_cacheDirectory, m_candidate);
  const auto partial = directory + "/" + m_candidate.fileName + ".part";
  if (!plainPath(directory) || !plainPath(partial)) return;
  m_metadataPath = directory + "/download.json";
  const auto size = QFileInfo(partial).size();
  if (size > 0 && size <= m_candidate.size && restoreDownloadMetadata())
  { m_state["received"] = size; m_state["resumable"] = true; }
  m_metadataPath.clear(); m_etag.clear();
}

bool AppUpdater::acceptDownloadHeaders(QNetworkReply* reply)
{
  if (m_headersAccepted) return true;
  const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
  if (status == 416 && m_requestOffset > 0)
  { restartDownload(); return false; }
  if (status != 200 && status != 206) return false;
  const QByteArray etag = reply->rawHeader("ETag");
  if (status == 206)
  {
    const QByteArray expected = "bytes " + QByteArray::number(m_requestOffset) + "-" +
      QByteArray::number(m_candidate.size - 1) + "/" + QByteArray::number(m_candidate.size);
    if (m_requestOffset <= 0 || reply->rawHeader("Content-Range") != expected || etag != m_etag || !strongEtag(etag))
    { restartDownload(); return false; }
  }
  else if (m_requestOffset > 0)
  {
    // A server may ignore Range or replace the asset. A complete response must
    // replace the partial file, never be appended to it.
    if (!m_file.resize(0) || !m_file.seek(0))
    { fail("无法重置更新文件。", true); return false; }
    m_requestOffset = 0; m_state["received"] = qint64(0);
  }
  const auto encoding = reply->rawHeader("Content-Encoding");
  if (!encoding.isEmpty() && encoding.toLower() != "identity")
  { fail("更新服务器返回了不支持的压缩内容。", true); return false; }
  m_etag = strongEtag(etag) ? etag : QByteArray();
  if (!saveDownloadMetadata())
  { fail("无法保存更新续传信息。", true); return false; }
  m_headersAccepted = true;
  return true;
}

void AppUpdater::beginDownloadRequest()
{
  if (!m_file.isOpen()) return;
  if (m_file.size() == m_candidate.size) { completeDownload(); return; }
  m_progressHighWater = qMax(m_progressHighWater, m_file.size());
  if (!strongEtag(m_etag) && m_file.size() > 0 && !m_file.resize(0))
  { fail("无法重置更新下载文件。", true); return; }
  m_requestOffset = m_file.size();
  if (!m_file.seek(m_requestOffset)) { fail("无法定位更新下载文件。", true); return; }
  m_headersAccepted = false;
  m_state["received"] = m_requestOffset;
  m_state["retrying"] = false;
  m_state["resumable"] = m_requestOffset > 0;
  m_transferClock.start(); m_progressClock.invalidate();
  publish("downloading");
  if (!m_file.isOpen() || m_state.value("status") != "downloading") return;
  // Always obtain a fresh signed asset redirect from the canonical URL.
  request(m_candidate.downloadUrl, false);
}

void AppUpdater::restartDownload()
{
  if (m_restartedFresh) { fail("服务器续传信息不匹配，请稍后重新下载。", true); return; }
  m_restartedFresh = true;
  if (m_reply)
  {
    auto* reply = m_reply.data(); m_reply.clear();
    disconnect(reply, nullptr, this, nullptr); reply->abort(); reply->deleteLater();
  }
  if (!m_file.resize(0) || !m_file.seek(0)) { fail("无法重置更新文件。", true); return; }
  m_etag.clear(); QFile::remove(m_metadataPath); m_state["received"] = qint64(0);
  m_retryTimer.start(0);
}

void AppUpdater::retryDownload(const QString& message)
{
  if (m_reply)
  {
    auto* reply = m_reply.data(); m_reply.clear();
    disconnect(reply, nullptr, this, nullptr); reply->abort(); reply->deleteLater();
  }
  if (!m_file.isOpen() || !m_file.flush()) { fail("无法保存更新进度。", true); return; }
  // Count consecutive attempts that did not grow the retained package. A
  // server ignoring Range must not refill the budget by rewriting its prefix.
  if (m_file.size() > m_progressHighWater)
  { m_progressHighWater = m_file.size(); m_retryCount = 0; }
  if (m_retryCount >= RetryLimit)
  { fail(strongEtag(m_etag) && m_file.size() > 0 ? "自动重试未完成，已保留进度，可点击继续下载。" : "自动重试未完成，请稍后重新下载。"); return; }
  const int delay = RetryDelays[m_retryCount++];
  m_state["retrying"] = true;
  m_state["retryAttempt"] = m_retryCount;
  m_state["retryDelay"] = delay / 1000;
  m_state["resumable"] = strongEtag(m_etag) && m_file.size() > 0;
  m_state["speed"] = qint64(0);
  m_retryTimer.start(delay);
  publish("downloading", message);
}

void AppUpdater::completeDownload()
{
  const bool flushed = m_file.flush();
  m_file.close();
  if (!flushed || !AppUpdatePolicy::verifyFile(m_file.fileName(), m_candidate))
  { fail("更新文件长度或 SHA-256 校验失败，请重新下载。", true); return; }
  m_readyPath = m_downloadDirectory + "/" + m_candidate.fileName;
  if (!plainPath(m_readyPath) || (QFile::exists(m_readyPath) && !QFile::remove(m_readyPath)) ||
      !QFile::rename(m_file.fileName(), m_readyPath))
  { fail("无法保存已校验的更新文件。"); return; }
  QFile::remove(m_metadataPath);
  m_state["received"] = m_candidate.size;
  m_state["retrying"] = false;
  m_state["resumable"] = false;
  m_state["speed"] = qint64(0);
  publish("ready");
}

void AppUpdater::finish(QNetworkReply* reply, bool metadata, int redirects)
{
  if (m_reply != reply) return;
  receive(reply, metadata);
  if (m_reply != reply) return;
  const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
  if (metadata && m_source == Source::LatestRelease)
  {
    checkReleaseManifest(reply, status);
    return;
  }
  if (status >= 300 && status < 400)
  {
    const QUrl target = reply->url().resolved(reply->attribute(QNetworkRequest::RedirectionTargetAttribute).toUrl());
    const QString host = target.host().toLower();
    const bool knownHost = metadata && m_source == Source::Api ? host == "api.github.com" :
      (host == "github.com" || host == "release-assets.githubusercontent.com" || host == "objects.githubusercontent.com");
    if (redirects >= 5 || !target.isValid() || target.scheme() != "https" || !knownHost ||
        !target.userInfo().isEmpty() || target.hasFragment() || (target.port() != -1 && target.port() != 443))
    {
      fail("更新服务器返回了不安全或过多的重定向。");
      return;
    }
    m_reply.clear();
    reply->deleteLater();
    request(target, metadata, redirects + 1);
    return;
  }
  if (reply->error() != QNetworkReply::NoError || (status != 200 && (metadata || status != 206)))
  {
    const auto error = reply->error();
    if (!metadata && (status == 403 || status == 408 || status == 429 || status >= 500 ||
        error == QNetworkReply::RemoteHostClosedError || error == QNetworkReply::TimeoutError ||
        error == QNetworkReply::OperationCanceledError || error == QNetworkReply::TemporaryNetworkFailureError ||
        error == QNetworkReply::HostNotFoundError || error == QNetworkReply::ConnectionRefusedError))
    { retryDownload("更新下载中断，正在重试。"); return; }
    if (metadata && m_source == Source::Api && (status == 403 || status == 429))
    {
      // The unauthenticated API allows 60 requests an hour per address, which a
      // shared proxy can exhaust. Release pages and downloads are not counted.
      m_reply.clear();
      reply->deleteLater();
      m_source = Source::LatestRelease;
      request(QUrl("https://github.com/Tigerest/Tigerest-Theater/releases/latest"), true);
      return;
    }
    fail(status == 403 || status == 429 || (metadata && m_source != Source::Api) ? RateLimited : "无法获取更新，请检查网络后重试。");
    return;
  }
  m_reply.clear();
  reply->deleteLater();
  if (metadata)
  {
    QJsonParseError parseError;
    const auto document = QJsonDocument::fromJson(m_metadata, &parseError);
    m_metadata.clear();
    const bool manifest = m_source == Source::Manifest;
    if (parseError.error != QJsonParseError::NoError ||
        (manifest ? !document.isObject() : !document.isArray() || document.array().size() > 30))
    {
      fail("更新服务器返回了无效的版本信息。");
      return;
    }
    const auto releases = manifest ?
      AppUpdatePolicy::manifestRelease(document.object(), m_fallbackTag, m_package) : document.array();
    // Without the API list an older release cannot be offered instead when the
    // newest one lacks this package, as before its Mac build is added.
    if (manifest && releases.isEmpty()) { fail(RateLimited); return; }
    m_candidate = AppUpdatePolicy::select(releases, m_currentVersion, m_package);
    if (m_candidate.valid() && !m_state.value("manual").toBool() && m_candidate.version == skippedVersion())
    {
      m_candidate = {};
      publish("idle");
      return;
    }
    refreshCachedProgress();
    publish(m_candidate.valid() ? "available" : "current");
    return;
  }
  if (m_file.size() < m_candidate.size) { retryDownload("下载尚未完成，正在重试。"); return; }
  completeDownload();
}

void AppUpdater::checkReleaseManifest(QNetworkReply* reply, int status)
{
  // releases/latest redirects to the newest stable release's tag page.
  static const QRegularExpression tagPage("^https://github\\.com/Tigerest/Tigerest-Theater/releases/tag/"
    "(v(?:0|[1-9][0-9]{0,8})\\.(?:0|[1-9][0-9]{0,8})\\.(?:0|[1-9][0-9]{0,8}))$");
  const QUrl target = reply->url().resolved(reply->attribute(QNetworkRequest::RedirectionTargetAttribute).toUrl());
  const auto match = tagPage.match(target.toString(QUrl::FullyEncoded));
  m_reply.clear();
  reply->deleteLater();
  if (status < 300 || status >= 400 || !match.hasMatch()) { fail(RateLimited); return; }
  m_metadata.clear();
  m_fallbackTag = match.captured(1);
  m_source = Source::Manifest;
  request(QUrl("https://github.com/Tigerest/Tigerest-Theater/releases/download/" + m_fallbackTag + "/" +
    AppUpdatePolicy::manifestName(m_fallbackTag, m_package)), true);
}

void AppUpdater::fail(const QString& message, bool discard)
{
  clearTransfer(discard);
  publish("error", message);
}

void AppUpdater::download()
{
  const QString status = m_state.value("status").toString();
  if (!m_candidate.valid() || (status != "available" && status != "error")) return;
  clearTransfer();
  m_retryCount = 0; m_progressHighWater = 0; m_restartedFresh = false;
  m_state["retryAttempt"] = 0;
  m_state["manual"] = true;
  m_state["deferred"] = false;
  m_state["installAfterDownload"] = true;
  if (!plainPath(m_cacheDirectory) || !QDir().mkpath(m_cacheDirectory))
  {
    fail("无法创建更新缓存目录。");
    return;
  }
  QFile::setPermissions(m_cacheDirectory, QFile::ReadOwner | QFile::WriteOwner | QFile::ExeOwner);
  m_downloadDirectory = candidateDirectory(m_cacheDirectory, m_candidate);
  if (!plainPath(m_downloadDirectory) || !QDir().mkpath(m_downloadDirectory)) { fail("无法创建更新缓存目录。"); return; }
  QFile::setPermissions(m_downloadDirectory, QFile::ReadOwner | QFile::WriteOwner | QFile::ExeOwner);
  m_file.setFileName(m_downloadDirectory + "/" + m_candidate.fileName + ".part");
  m_metadataPath = m_downloadDirectory + "/download.json";
  m_readyPath = m_downloadDirectory + "/" + m_candidate.fileName;
  const auto lockPath = m_downloadDirectory + "/download.lock";
  for (const auto& path : {m_file.fileName(), m_metadataPath, m_readyPath, lockPath})
    if (!plainPath(path)) { fail("更新缓存包含不安全的文件链接。"); return; }
  // A completed package is immutable and may be verified/read by another
  // window while its original downloader still owns the writer lock.
  if (AppUpdatePolicy::verifyFile(m_readyPath, m_candidate))
  { m_state["received"] = m_candidate.size; m_state["resumable"] = false; publish("ready"); return; }
  m_cacheLock = std::make_unique<QLockFile>(lockPath);
  m_cacheLock->setStaleLockTime(0);
  if (!m_cacheLock->tryLock(0)) { m_cacheLock.reset(); fail("另一个窗口正在下载此更新。"); return; }
  if (AppUpdatePolicy::verifyFile(m_readyPath, m_candidate))
  { m_state["received"] = m_candidate.size; m_state["resumable"] = false; publish("ready"); return; }
  if (!m_file.open(QIODevice::ReadWrite)) { fail("无法创建更新下载文件。"); return; }
  m_file.setPermissions(QFile::ReadOwner | QFile::WriteOwner);
  const bool resume = restoreDownloadMetadata() && m_file.size() > 0 && m_file.size() <= m_candidate.size;
  if (!resume)
  {
    m_etag.clear();
    if (!m_file.resize(0)) { fail("无法重置更新下载文件。", true); return; }
  }
  beginDownloadRequest();
}

void AppUpdater::install(bool automatic)
{
  if (automatic && !m_state.value("installAfterDownload").toBool()) return;
  if (m_state.value("status") != "ready") return;
  m_state["installAfterDownload"] = false;
  if (!AppUpdatePolicy::verifyFile(m_readyPath, m_candidate))
  {
    fail("更新文件已被修改或丢失，请重新下载。", true);
    return;
  }
  publish("installing");
  if (!m_launcher || !m_launcher(m_readyPath, m_package))
  {
    // Keep the verified download available if UAC or the OS opener is canceled.
    publish("ready", "未能打开更新包，请重试。");
    return;
  }
  m_packageOpened = true;
  // Opening a package hands control to the OS; it does not prove installation.
  // Keep explicit reopening possible after a canceled installer/archive viewer.
  publish("ready");
}

void AppUpdater::cancel()
{
  const QString status = m_state.value("status").toString();
  if (status != "checking" && status != "downloading") return;
  clearTransfer();
  publish(m_candidate.valid() ? "available" : "idle");
}

QString AppUpdater::skippedVersion() const
{
  QFile file(m_preferencePath);
  if (!file.open(QIODevice::ReadOnly) || file.size() > 4096) return {};
  return QJsonDocument::fromJson(file.readAll()).object().value("skippedVersion").toString();
}

void AppUpdater::skip()
{
  if (!m_candidate.valid() || m_state.value("status") == "installing") return;
  QDir().mkpath(QFileInfo(m_preferencePath).absolutePath());
  QSaveFile file(m_preferencePath);
  const auto json = QJsonDocument(QJsonObject{{"skippedVersion", m_candidate.version}}).toJson();
  if (!file.open(QIODevice::WriteOnly) || file.write(json) != json.size() || !file.commit())
  {
    publish(m_state.value("status").toString(), "无法保存跳过版本设置。");
    return;
  }
  clearTransfer(true);
  m_candidate = {};
  m_state["deferred"] = true;
  publish("idle");
}

void AppUpdater::defer()
{
  m_state["deferred"] = true;
  m_state["installAfterDownload"] = false;
  emit changed(m_state);
}
