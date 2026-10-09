#include "AppUpdater.h"
#include <QDir>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSaveFile>

using AppUpdatePolicy::Package;

static bool linked(const QString& path)
{
  const QFileInfo info(path);
  return info.isSymLink() || info.isJunction();
}

AppUpdater::AppUpdater(const QString& version, Package package, const QString& cacheDirectory,
                       const QString& preferencePath, QNetworkAccessManager* network, Launcher launcher, QObject* parent)
  : QObject(parent), m_currentVersion(version), m_package(package), m_cacheDirectory(cacheDirectory),
    m_preferencePath(preferencePath), m_network(network), m_launcher(std::move(launcher))
{
  m_state = {{"status", "idle"}, {"currentVersion", version}, {"version", ""},
    {"releaseUrl", "https://github.com/Tigerest/Tigerest-Theater/releases"}, {"notes", ""},
    {"size", qint64(0)}, {"received", qint64(0)}, {"error", ""}, {"manual", false}, {"deferred", false}, {"installAfterDownload", false},
    {"platform", package == Package::MacArm64 ? "macos" : package == Package::Unsupported ? "unsupported" : "windows"},
    {"installLabel", package == Package::WindowsInstaller ? "安装更新" : package == Package::WindowsPortable ? "打开 ZIP 更新包" : "打开 DMG 更新包"}};
  m_retryTimer.setSingleShot(true);
  connect(&m_retryTimer, &QTimer::timeout, this, &AppUpdater::requestPackage);
}

AppUpdater::~AppUpdater()
{
  // An installer or archive viewer may still be using the verified package.
  if (m_packageOpened) m_readyPath.clear();
  clearTransfer();
}

QVariantMap AppUpdater::state() const { return m_state; }

void AppUpdater::setRetryDelays(const QList<int>& milliseconds) { m_retryDelays = milliseconds; }

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

void AppUpdater::stopTransfer()
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
}

void AppUpdater::clearTransfer()
{
  stopTransfer();
  // The partial package stays on disk so a later attempt, even after a
  // restart, resumes it; the final SHA-256 check guards what was kept.
  if (m_file.isOpen()) m_file.close();
  if (!m_readyPath.isEmpty()) QFile::remove(m_readyPath);
  if (!m_downloadDirectory.isEmpty()) QDir().rmdir(m_downloadDirectory);
  m_file.setFileName(QString());
  m_readyPath.clear();
  m_downloadDirectory.clear();
  m_packageOpened = false;
  m_metadata.clear();
  m_failedAttempts = 0;
  m_state["received"] = qint64(0);
  m_state["installAfterDownload"] = false;
}

QString AppUpdater::packageDirectory() const
{
  return m_cacheDirectory + "/" + QString::fromLatin1(m_candidate.sha256.toHex());
}

void AppUpdater::removeStalePartials() const
{
  // Partial packages of superseded releases would otherwise accumulate.
  const QString current = QString::fromLatin1(m_candidate.sha256.toHex());
  for (const auto& entry : QDir(m_cacheDirectory).entryInfoList(QDir::Dirs | QDir::NoDotAndDotDot | QDir::NoSymLinks))
  {
    if (entry.fileName() == current || linked(entry.absoluteFilePath())) continue;
    for (const auto& part : QDir(entry.absoluteFilePath()).entryInfoList({"*.part"}, QDir::Files | QDir::NoSymLinks))
      QFile::remove(part.absoluteFilePath());
    QDir().rmdir(entry.absoluteFilePath());
  }
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
  m_candidate = {};
  if (m_package == Package::Unsupported)
  {
    publish("error", "此平台暂不支持应用内更新，请在发行页面查看可用版本。");
    return;
  }
  publish("checking");
  request(QUrl("https://api.github.com/repos/Tigerest/Tigerest-Theater/releases?per_page=30"), true);
}

void AppUpdater::request(const QUrl& url, bool metadata, int redirects)
{
  QNetworkRequest request(url);
  request.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::ManualRedirectPolicy);
  request.setHeader(QNetworkRequest::UserAgentHeader, "Tigerest-Theater-Updater/" + m_currentVersion);
  request.setRawHeader("Accept", metadata ? "application/vnd.github+json" : "application/octet-stream");
  request.setRawHeader("Accept-Encoding", "identity");
  if (metadata) request.setRawHeader("X-GitHub-Api-Version", "2022-11-28");
  if (!metadata && m_file.size() > 0) request.setRawHeader("Range", "bytes=" + QByteArray::number(m_file.size()) + "-");
  // Without data for this long the reply aborts and a package download resumes.
  request.setTransferTimeout(30000);
  auto* reply = m_network->get(request);
  m_reply = reply;
  reply->setReadBufferSize(128 * 1024);
  connect(reply, &QIODevice::readyRead, this, [this, reply, metadata] { receive(reply, metadata); });
  connect(reply, &QNetworkReply::finished, this, [this, reply, metadata, redirects] { finish(reply, metadata, redirects); });
  if (metadata)
  {
    QTimer::singleShot(30000, reply, [this, reply] {
      if (m_reply == reply) fail("检查更新超时，请检查网络后重试。");
    });
  }
}

void AppUpdater::requestPackage()
{
  m_attemptStart = m_file.size();
  m_packageAccepted = false;
  if (m_failedAttempts > 0)
    publish("downloading", QString("正在重新连接（第 %1/%2 次重试）…").arg(m_failedAttempts).arg(m_retryDelays.size()));
  // Each attempt starts at the release URL because the signed asset redirect expires.
  request(m_candidate.downloadUrl, false);
}

bool AppUpdater::acceptPackage(QNetworkReply* reply, int status)
{
  // A 200 answer to a resume request carries the whole package again.
  if (status == 200 && m_file.size() > 0 && !m_file.resize(0))
  {
    fail("无法写入更新文件，请检查可用空间和目录权限。");
    return false;
  }
  const qint64 offset = m_file.size();
  if (status == 206 && (offset == 0 || reply->rawHeader("Content-Range") != "bytes " + QByteArray::number(offset) + "-" +
      QByteArray::number(m_candidate.size - 1) + "/" + QByteArray::number(m_candidate.size)))
  {
    // The kept prefix cannot be trusted to line up with this response.
    if (!m_file.resize(0)) fail("无法写入更新文件，请检查可用空间和目录权限。");
    else retryPackage();
    return false;
  }
  bool hasLength = false;
  const qint64 contentLength = reply->header(QNetworkRequest::ContentLengthHeader).toLongLong(&hasLength);
  if (hasLength && contentLength != m_candidate.size - offset)
  {
    fail("更新响应大小不符合预期。");
    return false;
  }
  m_attemptStart = offset;
  m_packageAccepted = true;
  return true;
}

void AppUpdater::receive(QNetworkReply* reply, bool metadata)
{
  if (m_reply != reply) return;
  const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
  if (status != 200 && (metadata || status != 206)) return;
  if (metadata)
  {
    bool hasLength = false;
    const qint64 contentLength = reply->header(QNetworkRequest::ContentLengthHeader).toLongLong(&hasLength);
    if (hasLength && (contentLength < 0 || contentLength > AppUpdatePolicy::MaximumMetadataBytes))
    {
      fail("更新响应大小不符合预期。");
      return;
    }
  }
  else if (!m_packageAccepted && !acceptPackage(reply, status)) return;
  const qint64 maximum = metadata ? AppUpdatePolicy::MaximumMetadataBytes : m_candidate.size;
  while (reply->bytesAvailable() > 0)
  {
    const QByteArray bytes = reply->read(64 * 1024);
    if (bytes.isEmpty()) break;
    const qint64 received = metadata ? m_metadata.size() : m_file.size();
    if (bytes.size() > maximum - received)
    {
      fail("更新响应超过允许的大小。");
      return;
    }
    if (metadata) m_metadata.append(bytes);
    else
    {
      if (m_file.write(bytes) != bytes.size())
      {
        fail("无法写入更新文件，请检查可用空间和目录权限。");
        return;
      }
      m_state["received"] = m_file.size();
      m_state["error"] = QString();
    }
  }
  if (!metadata) emit changed(m_state);
}

void AppUpdater::finish(QNetworkReply* reply, bool metadata, int redirects)
{
  if (m_reply != reply) return;
  receive(reply, metadata);
  if (m_reply != reply) return;
  const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
  if (status >= 300 && status < 400)
  {
    const QUrl target = reply->url().resolved(reply->attribute(QNetworkRequest::RedirectionTargetAttribute).toUrl());
    const QString host = target.host().toLower();
    const bool knownHost = metadata ? host == "api.github.com" :
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
  if (metadata)
  {
    if (reply->error() != QNetworkReply::NoError || status != 200)
    {
      fail(status == 403 || status == 429 ? "GitHub 请求受限，请稍后重试。" : "无法检查更新，请检查网络后重试。");
      return;
    }
    m_reply.clear();
    reply->deleteLater();
    QJsonParseError parseError;
    const auto document = QJsonDocument::fromJson(m_metadata, &parseError);
    m_metadata.clear();
    if (parseError.error != QJsonParseError::NoError || !document.isArray() || document.array().size() > 30)
    {
      fail("更新服务器返回了无效的版本信息。");
      return;
    }
    m_candidate = AppUpdatePolicy::select(document.array(), m_currentVersion, m_package);
    if (m_candidate.valid() && !m_state.value("manual").toBool() && m_candidate.version == skippedVersion())
    {
      m_candidate = {};
      publish("idle");
      return;
    }
    publish(m_candidate.valid() ? "available" : "current");
    return;
  }
  if (reply->error() != QNetworkReply::NoError || (status != 200 && status != 206) || m_file.size() != m_candidate.size)
  {
    // Interrupted transfers, server faults and an expired asset signature (403)
    // are resumed; other client errors would only repeat.
    if (status != 0 && status != 200 && status != 206 && status != 403 && status != 408 &&
        status != 416 && status != 429 && status < 500)
    {
      fail(QString("无法下载更新文件（HTTP %1），请稍后重试。").arg(status));
      return;
    }
    if (status == 416 && !m_file.resize(0))
    {
      fail("无法写入更新文件，请检查可用空间和目录权限。");
      return;
    }
    retryPackage();
    return;
  }
  m_reply.clear();
  reply->deleteLater();
  const bool flushed = m_file.flush();
  m_file.close();
  if (!flushed || !AppUpdatePolicy::verifyFile(m_file.fileName(), m_candidate))
  {
    // A damaged package must not be resumed again.
    QFile::remove(m_file.fileName());
    fail("更新文件长度或 SHA-256 校验失败，请重新下载。");
    return;
  }
  m_readyPath = m_downloadDirectory + "/" + m_candidate.fileName;
  QFile::remove(m_readyPath);
  if (!QFile::rename(m_file.fileName(), m_readyPath))
  {
    fail("无法保存已校验的更新文件。");
    return;
  }
  publish("ready");
}

void AppUpdater::retryPackage()
{
  stopTransfer();
  if (m_file.size() > m_attemptStart) m_failedAttempts = 0;
  m_state["received"] = m_file.size();
  if (m_failedAttempts >= m_retryDelays.size())
  {
    fail("更新下载多次中断，已保留下载进度。请检查网络后点击“重试下载”继续。");
    return;
  }
  const int delay = m_retryDelays.at(m_failedAttempts++);
  publish("downloading", QString("下载中断，%1 秒后自动继续（第 %2/%3 次重试）。")
    .arg((delay + 999) / 1000).arg(m_failedAttempts).arg(m_retryDelays.size()));
  m_retryTimer.start(delay);
}

void AppUpdater::fail(const QString& message)
{
  clearTransfer();
  publish("error", message);
}

void AppUpdater::download()
{
  const QString status = m_state.value("status").toString();
  if (!m_candidate.valid() || (status != "available" && status != "error")) return;
  clearTransfer();
  m_state["manual"] = true;
  m_state["deferred"] = false;
  m_state["installAfterDownload"] = true;
  if (linked(m_cacheDirectory) || !QDir().mkpath(m_cacheDirectory))
  {
    fail("无法创建更新缓存目录。");
    return;
  }
  QFile::setPermissions(m_cacheDirectory, QFile::ReadOwner | QFile::WriteOwner | QFile::ExeOwner);
  removeStalePartials();
  // Keyed by the trusted digest so a restart finds this release's partial package.
  m_downloadDirectory = packageDirectory();
  if (linked(m_downloadDirectory) || !QDir().mkpath(m_downloadDirectory)) { fail("无法创建更新缓存目录。"); return; }
  QFile::setPermissions(m_downloadDirectory, QFile::ReadOwner | QFile::WriteOwner | QFile::ExeOwner);
  // An installer canceled before a restart left an already verified package.
  const QString readyPath = m_downloadDirectory + "/" + m_candidate.fileName;
  if (AppUpdatePolicy::verifyFile(readyPath, m_candidate))
  {
    m_readyPath = readyPath;
    m_state["received"] = m_candidate.size;
    publish("ready");
    return;
  }
  m_file.setFileName(readyPath + ".part");
  if (linked(m_file.fileName()) || !m_file.open(QIODevice::ReadWrite)) { fail("无法创建更新下载文件。"); return; }
  m_file.setPermissions(QFile::ReadOwner | QFile::WriteOwner);
  if (m_file.size() >= m_candidate.size && !m_file.resize(0)) { fail("无法创建更新下载文件。"); return; }
  if (!m_file.seek(m_file.size())) { fail("无法创建更新下载文件。"); return; }
  m_state["received"] = m_file.size();
  publish("downloading");
  requestPackage();
}

void AppUpdater::install(bool automatic)
{
  if (automatic && !m_state.value("installAfterDownload").toBool()) return;
  if (m_state.value("status") != "ready") return;
  m_state["installAfterDownload"] = false;
  if (!AppUpdatePolicy::verifyFile(m_readyPath, m_candidate))
  {
    fail("更新文件已被修改或丢失，请重新下载。");
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
  // The partial package is kept, so downloading again resumes it.
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
  clearTransfer();
  // Nothing will resume a skipped release.
  QFile::remove(packageDirectory() + "/" + m_candidate.fileName + ".part");
  QDir().rmdir(packageDirectory());
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
