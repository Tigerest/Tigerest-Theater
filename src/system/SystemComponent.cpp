#include <QSysInfo>
#include <QProcess>
#include <QMap>
#include <QtNetwork/qnetworkinterface.h>
#include <QGuiApplication>
#include <QCursor>
#include <QDesktopServices>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonObject>
#include <QJsonDocument>
#include <QNetworkRequest>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QSslConfiguration>
#include <QSslSocket>
#include <QSslCertificate>
#include <QSslError>
#include <QDebug>
#include <QRegularExpression>
#include <QPointer>
#include <QSaveFile>
#include <QJsonArray>
#include <QUuid>
#include <QDateTime>
#include <QFileDialog>
#include <QStandardPaths>
#include <QWindow>
#include <algorithm>
#include <functional>
#include <utility>

#include <QtWebEngineCore/qtwebenginecoreglobal.h>

#include "input/InputComponent.h"
#include "SystemComponent.h"
#include "AppUpdater.h"
#include "InstallerHandoff.h"
#include "ReleaseFeed.h"
#include "CommunityBridge.h"
#include "LocalMedia.h"
#include "MainThreadWatchdog.h"
#include "player/PlayerComponent.h"
#include "Version.h"
#include "settings/SettingsComponent.h"
#include "player/MpvConfigManager.h"
#include "settings/SettingsSection.h"
#include "Paths.h"
#include "core/ProfileManager.h"
#include "core/Globals.h"
#include "Names.h"
#include "utils/Utils.h"
#include "utils/Log.h"

#ifdef Q_OS_WIN
#include <windows.h>
#include <shellapi.h>
#undef interface
#endif


#define KONVERGO_PRODUCTID_DEFAULT  3
#define KONVERGO_PRODUCTID_OPENELEC 4

// Platform types map
QMap<SystemComponent::PlatformType, QString> g_platformTypeNames = { \
  { SystemComponent::platformTypeOsx, "macosx" }, \
  { SystemComponent::platformTypeWindows, "windows" },
  { SystemComponent::platformTypeLinux, "linux" },
  { SystemComponent::platformTypeOpenELEC, "openelec" },
  { SystemComponent::platformTypeFreeBSD, "freebsd" },
  { SystemComponent::platformTypeUnknown, "unknown" },
};

// platform Archictecture map
QMap<SystemComponent::PlatformArch, QString> g_platformArchNames = {
  { SystemComponent::platformArchX86_32, "i386" },
  { SystemComponent::platformArchX86_64, "x86_64" },
  { SystemComponent::platformArchRpi2, "rpi2" },
  { SystemComponent::platformArchUnknown, "unknown" }
};


///////////////////////////////////////////////////////////////////////////////////////////////////
SystemComponent::SystemComponent(QObject* parent) : ComponentBase(parent), m_platformType(platformTypeUnknown), m_platformArch(platformArchUnknown), m_doLogMessages(false), m_scale(1), m_connectivityCheckReply(nullptr), m_resolveUrlReply(nullptr)
{
  m_networkManager = new QNetworkAccessManager(this);
  m_communityBridge = new CommunityBridge(this);
  connect(m_communityBridge, &CommunityBridge::response, this, &SystemComponent::communityResponse);
  m_watchdog = new MainThreadWatchdog(this);
  connect(m_watchdog, &MainThreadWatchdog::stallRecovered, this, &SystemComponent::mainThreadStallRecovered);
  connect(m_communityBridge, &CommunityBridge::mappingAuthChanged, this, [](const QString& path, const QString& generation) {
    PlayerComponent::Get().updateDanmakuAuthorization(path, generation);
  });
  m_localFilesBatch.setSingleShot(true);
  m_localFilesBatch.setInterval(500);
  connect(&m_localFilesBatch, &QTimer::timeout, this, &SystemComponent::localFilesRequested);

// define OS Type
#if defined(Q_OS_MAC)
  m_platformType = platformTypeOsx;
#elif defined(Q_OS_WIN)
  m_platformType = platformTypeWindows;
#elif defined(KONVERGO_OPENELEC)
  m_platformType = platformTypeOpenELEC;
#elif defined(Q_OS_LINUX)
  m_platformType = platformTypeLinux;
#elif defined(Q_OS_FREEBSD)
  m_platformType = platformTypeFreeBSD;
#endif

// define target type
#ifdef TARGET_RPI
  m_platformArch = platformArchRpi2;
#elif defined(Q_PROCESSOR_X86_32)
  m_platformArch = platformArchX86_32;
#elif defined(Q_PROCESSOR_X86_64)
  m_platformArch = platformArchX86_64;
#endif

  if (auto* s = SettingsComponent::Get().getSection(SETTINGS_SECTION_AUDIO))
  {
    connect(s, &SettingsSection::valuesUpdated, [=]()
    {
      emit capabilitiesChanged(getCapabilitiesString());
    });
  }
}

/////////////////////////////////////////////////////////////////////////////////////////
bool SystemComponent::componentInitialize()
{
  QDir().mkpath(ProfileManager::activeProfile().dataDir("scripts"));
  QDir().mkpath(ProfileManager::activeProfile().dataDir("sounds"));

  if (!MpvConfigManager::prepare())
    qWarning() << "MPV will start with libmpv defaults because configuration preparation failed";

  QDir().mkpath(downloadsDirectory() + "/files");
  loadDownloadIndex();

  using AppUpdatePolicy::Package;
  Package package = Package::Unsupported;
#if defined(Q_OS_WIN) && defined(Q_PROCESSOR_X86_64)
  package = Paths::isPortableMode() ? Package::WindowsPortable : Package::WindowsInstaller;
#elif defined(Q_OS_MAC) && defined(Q_PROCESSOR_ARM_64)
  package = Package::MacArm64;
#endif
  if (!m_appUpdater)
  {
    // Keep TLS policy isolated from media servers' optional self-signed SSL support.
    auto* network = new QNetworkAccessManager(this);
    m_appUpdater = new AppUpdater(Version::GetVersionString(), package,
      ProfileManager::activeProfile().cacheDir("updates"),
      ProfileManager::activeProfile().dataDir("app-update-preferences.json"), network,
      [this](const QString& path, Package kind) {
#ifdef Q_OS_WIN
        if (kind == Package::WindowsInstaller)
        {
          if (!m_installerHandoff)
          {
            m_installerHandoff = new InstallerHandoff(this);
            connect(m_installerHandoff, &InstallerHandoff::closeRequested, this, [this] {
              qInfo() << "Update installer is ready; closing so it can install and restart the new version";
              exit();
            });
            connect(m_installerHandoff, &InstallerHandoff::returned, this, [this] {
              m_appUpdater->installerReturned("安装程序已退出，没有完成更新，可以再次点击安装。");
            });
          }
          return m_installerHandoff->start(path);
        }
#else
        Q_UNUSED(kind);
#endif
        return QDesktopServices::openUrl(QUrl::fromLocalFile(path));
      }, this);
    m_appUpdater->setReleaseFeed(ReleaseFeed::address(), ReleaseFeed::productionKeys());
    connect(m_appUpdater, &AppUpdater::changed, this, &SystemComponent::appUpdateChanged);
    connect(m_appUpdater, &AppUpdater::openUrl, this, [](const QUrl& url) { QDesktopServices::openUrl(url); });
  }

  return true;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
QString SystemComponent::downloadsDirectory() const
{
  return ProfileManager::activeProfile().dataDir("downloads");
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void SystemComponent::openLocalFiles(const QStringList& files, bool atStartup)
{
  if (files.isEmpty())
    return;
  if (atStartup)
    m_startedWithLocalFiles = true;
  for (const QString& file : files)
  {
    if (!m_localFiles.contains(file, Qt::CaseInsensitive))
      m_localFiles << file;
  }
  m_localFileDirectory = QFileInfo(files.last()).absolutePath();
  qInfo() << "Local files requested:" << files.size();
  m_localFilesBatch.start();
}

///////////////////////////////////////////////////////////////////////////////////////////////////
QVariantList SystemComponent::takeLocalFiles()
{
  // A batch still gathering launches is announced by localFilesRequested.
  if (m_localFilesBatch.isActive() || m_localFiles.isEmpty())
    return {};
  const QVariantList entries = LocalMedia::playlist(LocalMedia::sorted(m_localFiles));
  m_localFiles.clear();
  return entries;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
bool SystemComponent::chooseLocalFiles()
{
  if (m_localFileDialog)
    return false;
  QString directory = m_localFileDirectory;
  if (directory.isEmpty() || !QFileInfo(directory).isDir())
    directory = QStandardPaths::writableLocation(QStandardPaths::MoviesLocation);
  auto* dialog = new QFileDialog(nullptr, QStringLiteral("打开本地视频"), directory);
  m_localFileDialog = dialog;
  dialog->setAttribute(Qt::WA_DeleteOnClose);
  dialog->setFileMode(QFileDialog::ExistingFiles);
  dialog->setNameFilters(LocalMedia::dialogFilters());
  // Owned by the main window, so it stays in front of it, also when the
  // window is kept on top.
  if (QWindow* main = Globals::MainWindow())
  {
    dialog->winId();
    if (dialog->windowHandle())
      dialog->windowHandle()->setTransientParent(main);
  }
  connect(dialog, &QFileDialog::filesSelected, this, [this](const QStringList& selected) {
    openLocalFiles(LocalMedia::filesFromArguments(selected, QDir::currentPath()));
  });
  dialog->open();
  return true;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
static QVariant firstDownloadValue(const QVariantMap& info, const QStringList& keys)
{
  for (const QString& key : keys)
  {
    if (info.contains(key) && info.value(key).isValid())
      return info.value(key);
  }
  return QVariant();
}

///////////////////////////////////////////////////////////////////////////////////////////////////
static QString safeDownloadName(QString name)
{
  name = QFileInfo(name).fileName().trimmed();
  name.replace(QRegularExpression("[\\x00-\\x1f<>:\"/\\\\|?*]"), "_");
  name.replace(QRegularExpression("[. ]+$"), "");
  if (name.isEmpty()) name = "offline-media";
  if (name.length() > 160) name = name.left(160);
  return name;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
QString SystemComponent::startDownload(const QVariantMap& info)
{
  const QString rawUrl = firstDownloadValue(info, {"url", "Url", "downloadUrl", "DownloadUrl"}).toString();
  const QUrl url(rawUrl);
  if (!url.isValid() || (url.scheme() != "http" && url.scheme() != "https"))
  {
    emit hostMessage("下载地址无效");
    return QString();
  }

  const QString id = QUuid::createUuid().toString(QUuid::Id128);
  QString fileName = firstDownloadValue(info, {"fileName", "filename", "FileName", "name", "Name"}).toString();
  if (fileName.isEmpty()) fileName = QFileInfo(url.path()).fileName();
  fileName = safeDownloadName(fileName);
  if (QFileInfo(fileName).suffix().isEmpty()) fileName += ".media";

  const QString localName = id.left(12) + "-" + fileName;
  QVariantMap item;
  item["id"] = id;
  item["itemId"] = firstDownloadValue(info, {"itemId", "ItemId", "id", "Id"});
  item["title"] = firstDownloadValue(info, {"title", "Title", "name", "Name"}).toString();
  if (item["title"].toString().isEmpty()) item["title"] = QFileInfo(fileName).completeBaseName();
  item["fileName"] = fileName;
  item["localPath"] = QDir(downloadsDirectory() + "/files").filePath(localName);
  item["status"] = "queued";
  item["received"] = 0;
  item["total"] = -1;
  item["createdUtc"] = QDateTime::currentDateTimeUtc().toString(Qt::ISODate);

  m_downloads[id] = item;
  m_downloadUrls[id] = url; // Deliberately never persisted: it may contain an access token.
  saveDownloadIndex();
  emitDownloadsChanged();
  startDownloadRequest(id, url, false);
  return id;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void SystemComponent::startDownloadRequest(const QString& id, const QUrl& url, bool resume)
{
  if (!m_downloads.contains(id) || m_activeDownloads.contains(id)) return;

  QVariantMap item = m_downloads.value(id);
  const QString targetPath = item.value("localPath").toString();
  const QString partPath = targetPath + ".part";
  qint64 existingSize = resume ? QFileInfo(partPath).size() : 0;

  QNetworkRequest request(url);
  request.setHeader(QNetworkRequest::UserAgentHeader, getUserAgent());
  request.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::NoLessSafeRedirectPolicy);
  if (existingSize > 0)
    request.setRawHeader("Range", QByteArray("bytes=") + QByteArray::number(existingSize) + "-");

  QNetworkReply* reply = m_networkManager->get(request);
  if (SettingsComponent::Get().ignoreSSLErrors())
    connect(reply, QOverload<const QList<QSslError>&>::of(&QNetworkReply::sslErrors),
            reply, QOverload<>::of(&QNetworkReply::ignoreSslErrors));

  QFile* file = new QFile(partPath, reply);
  if (!file->open(existingSize > 0 ? QIODevice::Append : QIODevice::WriteOnly))
  {
    reply->abort();
    reply->deleteLater();
    item["status"] = "error";
    item["error"] = "无法创建离线文件";
    m_downloads[id] = item;
    saveDownloadIndex();
    emitDownloadsChanged();
    return;
  }

  auto* active = new ActiveDownload;
  active->reply = reply;
  active->file = file;
  m_activeDownloads[id] = active;
  item["status"] = "downloading";
  item.remove("error");
  m_downloads[id] = item;
  emitDownloadsChanged();

  connect(reply, &QNetworkReply::metaDataChanged, this, [file, reply, existingSize]() {
    if (existingSize > 0 && reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt() != 206)
    {
      file->close();
      file->open(QIODevice::WriteOnly | QIODevice::Truncate);
    }
  });
  connect(reply, &QIODevice::readyRead, this, [file, reply]() {
    file->write(reply->readAll());
  });
  connect(reply, &QNetworkReply::downloadProgress, this, [this, id](qint64 received, qint64 total) {
    if (!m_downloads.contains(id)) return;
    QVariantMap item = m_downloads.value(id);
    const qint64 base = QFileInfo(item.value("localPath").toString() + ".part").size() - received;
    item["received"] = qMax<qint64>(0, base) + received;
    item["total"] = total > 0 ? qMax<qint64>(0, base) + total : total;
    m_downloads[id] = item;
    emitDownloadsChanged();
  });
  connect(reply, &QNetworkReply::finished, this, [this, id, reply, file, partPath, targetPath]() {
    ActiveDownload* active = m_activeDownloads.take(id);
    file->write(reply->readAll());
    file->flush();
    file->close();

    if (!m_downloads.contains(id))
    {
      delete active;
      reply->deleteLater();
      return;
    }

    QVariantMap item = m_downloads.value(id);
    if (active && active->canceled)
    {
      QFile::remove(partPath);
      m_downloads.remove(id);
      m_downloadUrls.remove(id);
    }
    else if (active && active->paused)
    {
      item["status"] = "paused";
      m_downloads[id] = item;
    }
    else if (reply->error() == QNetworkReply::NoError)
    {
      QFile::remove(targetPath);
      if (QFile::rename(partPath, targetPath))
      {
        item["status"] = "completed";
        item["received"] = QFileInfo(targetPath).size();
        item["total"] = item["received"];
        item["completedUtc"] = QDateTime::currentDateTimeUtc().toString(Qt::ISODate);
        m_downloads[id] = item;
        m_downloadUrls.remove(id);
      }
      else
      {
        item["status"] = "error";
        item["error"] = "无法完成离线文件写入";
        m_downloads[id] = item;
      }
    }
    else
    {
      item["status"] = "error";
      item["error"] = QString("网络错误 %1").arg(static_cast<int>(reply->error()));
      m_downloads[id] = item;
    }

    delete active;
    reply->deleteLater();
    saveDownloadIndex();
    emitDownloadsChanged();
  });
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void SystemComponent::pauseDownload(const QString& id)
{
  ActiveDownload* active = m_activeDownloads.value(id, nullptr);
  if (!active || !active->reply) return;
  active->paused = true;
  active->reply->abort();
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void SystemComponent::resumeDownload(const QString& id)
{
  if (!m_downloads.contains(id) || !m_downloadUrls.contains(id)) return;
  startDownloadRequest(id, m_downloadUrls.value(id), true);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void SystemComponent::cancelDownload(const QString& id)
{
  ActiveDownload* active = m_activeDownloads.value(id, nullptr);
  if (active && active->reply)
  {
    active->canceled = true;
    active->reply->abort();
    return;
  }
  if (m_downloads.contains(id))
  {
    QFile::remove(m_downloads.value(id).value("localPath").toString() + ".part");
    m_downloads.remove(id);
    m_downloadUrls.remove(id);
    saveDownloadIndex();
    emitDownloadsChanged();
  }
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void SystemComponent::removeDownload(const QString& id)
{
  if (!m_downloads.contains(id)) return;
  const QString localPath = m_downloads.value(id).value("localPath").toString();
  cancelDownload(id);

  // cancelDownload() removes a completed item from the index immediately, so
  // retain and delete its final path independently of the map entry. Active
  // downloads may still have their .part file open; their finished handler
  // repeats that cleanup after aborting.
  QFile::remove(localPath);
  QFile::remove(localPath + ".part");
  if (m_downloads.contains(id))
  {
    m_downloads.remove(id);
    m_downloadUrls.remove(id);
    saveDownloadIndex();
    emitDownloadsChanged();
  }
}

///////////////////////////////////////////////////////////////////////////////////////////////////
QVariantList SystemComponent::downloads() const
{
  QVariantList result;
  for (const QVariantMap& item : m_downloads)
    result.push_back(item);
  std::sort(result.begin(), result.end(), [](const QVariant& a, const QVariant& b) {
    return a.toMap().value("createdUtc").toString() > b.toMap().value("createdUtc").toString();
  });
  return result;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
QVariantMap SystemComponent::downloadInfo(const QString& id) const
{
  QVariantMap item = m_downloads.value(id);
  if (item.value("status") == "completed" && QFile::exists(item.value("localPath").toString()))
    item["localUrl"] = QUrl::fromLocalFile(item.value("localPath").toString()).toString();
  return item;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void SystemComponent::emitDownloadsChanged()
{
  emit downloadsChanged(downloads());
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void SystemComponent::loadDownloadIndex()
{
  QFile file(downloadsDirectory() + "/index.json");
  if (!file.open(QIODevice::ReadOnly)) return;
  const QJsonDocument doc = QJsonDocument::fromJson(file.readAll());
  for (const QJsonValue& value : doc.array())
  {
    QVariantMap item = value.toObject().toVariantMap();
    const QString id = item.value("id").toString();
    if (id.isEmpty()) continue;
    if (item.value("status") != "completed")
    {
      item["status"] = "error";
      item["error"] = "客户端重启后请重新发起下载";
    }
    if (item.value("status") == "completed" && !QFile::exists(item.value("localPath").toString()))
    {
      item["status"] = "missing";
      item["error"] = "本地文件不存在";
    }
    m_downloads[id] = item;
  }
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void SystemComponent::saveDownloadIndex() const
{
  QJsonArray array;
  for (QVariantMap item : m_downloads)
  {
    item.remove("url");
    item.remove("headers");
    array.push_back(QJsonObject::fromVariantMap(item));
  }
  QSaveFile file(downloadsDirectory() + "/index.json");
  if (file.open(QIODevice::WriteOnly | QIODevice::Text))
  {
    file.write(QJsonDocument(array).toJson(QJsonDocument::Indented));
    file.commit();
  }
}

/////////////////////////////////////////////////////////////////////////////////////////
void SystemComponent::crashApp()
{
  *static_cast<volatile int*>(nullptr) = 0;
}

/////////////////////////////////////////////////////////////////////////////////////////
static QString stallFaultFile()
{
  return QDir(ProfileManager::activeProfile().logDir()).filePath(QStringLiteral("main-thread-stall.json"));
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void SystemComponent::componentPostInitialize()
{
  // Read before the watchdog can write a new stall for this process.
  m_unfinishedFault = MainThreadWatchdog::takeUnfinishedFault(stallFaultFile());
  if (!m_unfinishedFault.isEmpty())
    qWarning() << "Previous run ended during a main-thread stall of at least"
               << m_unfinishedFault.value("durationMs").toLongLong() << "ms";
  connect(qApp, &QCoreApplication::aboutToQuit, m_watchdog, &MainThreadWatchdog::stop);
  InputComponent::Get().registerHostCommand("crash!", this, "crashApp");
  InputComponent::Get().registerHostCommand("script", this, "runUserScript");
}

///////////////////////////////////////////////////////////////////////////////////////////////////
QString SystemComponent::getPlatformTypeString() const
{
  return g_platformTypeNames[m_platformType];
}

///////////////////////////////////////////////////////////////////////////////////////////////////
QString SystemComponent::getPlatformArchString() const
{
  return g_platformArchNames[m_platformArch];
}

///////////////////////////////////////////////////////////////////////////////////////////////////
QVariantMap SystemComponent::systemInformation() const
{
  QVariantMap info;
  QString build;
  QString dist;
  QString arch;
  int productid = KONVERGO_PRODUCTID_DEFAULT;

#ifdef Q_OS_WIN
  arch = (sizeof(void *) == 8) ? "x86_64" : "i386";
#else
  arch = QSysInfo::currentCpuArchitecture();
#endif

  build = getPlatformTypeString();
  dist = getPlatformTypeString();

#if defined(KONVERGO_OPENELEC)
  productid = KONVERGO_PRODUCTID_OPENELEC;
  dist = "openelec";

  if (m_platformArch == platformArchRpi2)
  {
    build = "rpi2";
  }
  else
  {
    build = "generic";
  }
#endif

  
  info["build"] = build + "-" + arch;
  info["dist"] = dist;
  info["version"] = Version::GetVersionString();
  info["productid"] = productid;
  
 qDebug() << QString(
                "System Information : build(%1)-arch(%2).dist(%3).version(%4).productid(%5)")
                .arg(build)
                .arg(arch)
                .arg(dist)
                .arg(Version::GetVersionString())
                .arg(productid);
 return info;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void SystemComponent::exit()
{
#ifdef Q_OS_WIN
  PlayerComponent::Get().requestApplicationQuit();
#else
  qApp->quit();
#endif
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void SystemComponent::restart()
{
  qApp->quit();
  QProcess::startDetached(qApp->arguments()[0], qApp->arguments());
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void SystemComponent::jsLog(int level, QString text)
{
  switch (level) {
    case 0: // Info
      qInfo() << "JS:" << qPrintable(text);
      break;
    case 1: // Warning
      qWarning() << "JS:" << qPrintable(text);
      break;
    case 2: // Error
      qCritical() << "JS:" << qPrintable(text);
      break;
    default:
      qDebug() << "JS: [uncaught level=" << level << "]" << qPrintable(text);
      break;
  }
}

///////////////////////////////////////////////////////////////////////////////////////////////////
QString SystemComponent::extractBaseUrl(const QString& url)
{
  QUrl parsedUrl(url);
  if (!parsedUrl.isValid() || parsedUrl.host().isEmpty() ||
      (parsedUrl.scheme() != "http" && parsedUrl.scheme() != "https"))
    return QString();
  QString path = parsedUrl.path();
  // Only a complete /web segment marks the web client, not /webdav.
  const QRegularExpression webSegment(QStringLiteral("/web(?=/|$)"),
                                      QRegularExpression::CaseInsensitiveOption);
  auto matches = webSegment.globalMatch(path);
  qsizetype webIndex = -1;
  while (matches.hasNext()) webIndex = matches.next().capturedStart();
  if (webIndex >= 0) path.truncate(webIndex);
  while (path.endsWith('/')) path.chop(1);
  parsedUrl.setPath(path);
  parsedUrl.setQuery(QString());
  parsedUrl.setFragment(QString());
  parsedUrl.setUserInfo(QString());
  if ((parsedUrl.scheme() == "https" && parsedUrl.port() == 443) ||
      (parsedUrl.scheme() == "http" && parsedUrl.port() == 80))
    parsedUrl.setPort(-1);
  return parsedUrl.toString(QUrl::FullyEncoded);
}

///////////////////////////////////////////////////////////////////////////////////////////////////
QSslConfiguration SystemComponent::getSSLConfiguration()
{
  QSslConfiguration sslConfig = QSslConfiguration::defaultConfiguration();
  if (SettingsComponent::Get().ignoreSSLErrors()) {
    sslConfig.setPeerVerifyMode(QSslSocket::VerifyNone);
  } else if (SettingsComponent::Get().autodetectCertBundle()) {
    QString certPath = SettingsComponent::Get().detectCertBundlePath();
    if (!certPath.isEmpty()) {
      QList<QSslCertificate> certs = QSslCertificate::fromPath(certPath);
      if (!certs.isEmpty()) {
        sslConfig.setCaCertificates(certs);
      }
    }
  }
  return sslConfig;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void SystemComponent::setReplyTimeout(QNetworkReply* reply, int ms)
{
  QPointer<QNetworkReply> replyPtr(reply);
  QTimer::singleShot(ms, this, [replyPtr]() {
    if (replyPtr && !replyPtr->isFinished()) {
      replyPtr->abort();
    }
  });
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void SystemComponent::resolveUrl(const QString& url, std::function<void(const QString&)> callback,
                                 int timeoutMs)
{
  // Abort any pending resolve
  if (m_resolveUrlReply) {
    QNetworkReply* previousReply = m_resolveUrlReply;
    m_resolveUrlReply = nullptr;
    previousReply->abort();
    previousReply->deleteLater();
  }

  QNetworkRequest request(url);
  request.setHeader(QNetworkRequest::UserAgentHeader, getUserAgent());
  request.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::NoLessSafeRedirectPolicy);
  request.setSslConfiguration(getSSLConfiguration());

  m_resolveUrlReply = m_networkManager->head(request);

  QNetworkReply* reply = m_resolveUrlReply;
  setReplyTimeout(reply, timeoutMs);

  if (SettingsComponent::Get().ignoreSSLErrors()) {
    connect(reply, QOverload<const QList<QSslError>&>::of(&QNetworkReply::sslErrors),
            reply, QOverload<>::of(&QNetworkReply::ignoreSslErrors));
  }
  connect(reply, &QNetworkReply::finished, this, [this, reply, callback]() {
    if (reply->error() == QNetworkReply::OperationCanceledError) {
      // cancelServerConnectivity() and a newer request clear the member before
      // aborting. If this is still the active reply, its own timeout fired.
      const bool timedOut = m_resolveUrlReply == reply;
      reply->deleteLater();
      if (timedOut) {
        m_resolveUrlReply = nullptr;
        callback(QString());
      }
      return;
    }

    if (reply->error() != QNetworkReply::NoError) {
      qWarning() << "resolveUrl: error:" << reply->errorString();
    }

    callback(reply->url().toString());
    reply->deleteLater();
    if (m_resolveUrlReply == reply) {
      m_resolveUrlReply = nullptr;
    }
  });
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void SystemComponent::checkServerConnectivity(QString url)
{
  cancelServerConnectivity();
  const QString base = extractBaseUrl(url);
  if (base.isEmpty()) {
    emit serverConnectivityResult(url, false, QString(), tr("服务器地址无效，请使用 HTTP 或 HTTPS 地址"));
    return;
  }
  checkServerBase(url, base, true, m_connectivityGeneration);
}

void SystemComponent::checkServerBase(const QString& url, const QString& base,
                                      bool discoverPath, quint64 generation)
{
  QNetworkRequest request(base + "/System/Info/Public");
  request.setHeader(QNetworkRequest::UserAgentHeader, getUserAgent());
  request.setRawHeader("Cache-Control", "no-cache");
  request.setAttribute(QNetworkRequest::RedirectPolicyAttribute, QNetworkRequest::NoLessSafeRedirectPolicy);
  request.setSslConfiguration(getSSLConfiguration());
  auto* reply = m_networkManager->get(request);
  m_connectivityCheckReply = reply;
  setReplyTimeout(reply, CONNECTIVITY_REQUEST_TIMEOUT_MS);
  if (SettingsComponent::Get().ignoreSSLErrors()) {
    connect(reply, QOverload<const QList<QSslError>&>::of(&QNetworkReply::sslErrors),
            reply, QOverload<>::of(&QNetworkReply::ignoreSslErrors));
  }
  connect(reply, &QNetworkReply::finished, this, [this, reply, url, base, discoverPath, generation]() {
    reply->deleteLater();
    if (generation != m_connectivityGeneration || m_connectivityCheckReply != reply) return;
    m_connectivityCheckReply = nullptr;
    const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    const bool networkOk = reply->error() == QNetworkReply::NoError;
    const auto doc = networkOk ? QJsonDocument::fromJson(reply->readAll()) : QJsonDocument();
    if (doc.isObject() && !doc.object().value("Id").toString().isEmpty()) {
      // Keep the authority supplied by the user, including forwarded ports.
      // A successful API redirect can also reveal a reverse-proxy prefix.
      QUrl webUrl(base);
      QString apiPath = reply->url().path();
      const QString apiSuffix = QStringLiteral("/System/Info/Public");
      if (apiPath.endsWith(apiSuffix, Qt::CaseInsensitive)) {
        apiPath.chop(apiSuffix.size());
        webUrl.setPath(apiPath + "/web/index.html");
      } else {
        webUrl.setPath(webUrl.path() + "/web/index.html");
      }
      emit serverConnectivityResult(url, true, webUrl.toString(QUrl::FullyEncoded), QString());
      return;
    }
    QString error;
    if (reply->error() == QNetworkReply::OperationCanceledError)
      error = tr("连接超时（5 秒）");
    else if (status >= 400)
      error = tr("服务器返回 HTTP %1").arg(status);
    else if (!networkOk)
      error = tr("网络连接失败：%1").arg(reply->errorString());
    else
      error = tr("此地址未返回有效的 Emby 或 Jellyfin 服务器信息");

    // A root URL may redirect to an installation under /emby or /jellyfin.
    // Discover that path only after the exact API failed; never replace the
    // user's host/port with an internal authority advertised by a proxy.
    if (discoverPath && (status == 404 || networkOk)) {
      resolveUrl(url, [this, url, base, generation, error](const QString& resolved) {
        if (generation != m_connectivityGeneration) return;
        QUrl candidate(base);
        const QString resolvedBase = extractBaseUrl(resolved);
        if (!resolvedBase.isEmpty()) candidate.setPath(QUrl(resolvedBase).path());
        const QString nextBase = extractBaseUrl(candidate.toString());
        if (!nextBase.isEmpty() && nextBase != base)
          checkServerBase(url, nextBase, false, generation);
        else
          emit serverConnectivityResult(url, false, QString(), error);
      }, CONNECTIVITY_REQUEST_TIMEOUT_MS);
      return;
    }
    emit serverConnectivityResult(url, false, QString(), error);
  });
}

///////////////////////////////////////////////////////////////////////////////////////////////////
void SystemComponent::cancelServerConnectivity()
{
  ++m_connectivityGeneration;
  // Save pointers before abort() since it synchronously triggers finished handlers
  // which may set member variables to nullptr
  if (m_resolveUrlReply) {
    QNetworkReply* reply = m_resolveUrlReply;
    m_resolveUrlReply = nullptr;
    reply->abort();
    reply->deleteLater();
  }

  if (m_connectivityCheckReply) {
    QNetworkReply* reply = m_connectivityCheckReply;
    m_connectivityCheckReply = nullptr;
    reply->abort();
    reply->deleteLater();
  }

}

///////////////////////////////////////////////////////////////////////////////////////////////////
bool SystemComponent::isAddressOnLocalSubnet(const QString& address) const
{
  QHostAddress targetAddress;
  if (!targetAddress.setAddress(address)) {
    return false;
  }

  for (const QNetworkInterface& interface : QNetworkInterface::allInterfaces()) {
    const QNetworkInterface::InterfaceFlags flags = interface.flags();
    if (!(flags & QNetworkInterface::IsUp) ||
        !(flags & QNetworkInterface::IsRunning) ||
        (flags & QNetworkInterface::IsLoopBack)) {
      continue;
    }

    for (const QNetworkAddressEntry& entry : interface.addressEntries()) {
      const QHostAddress localAddress = entry.ip();
      const int prefixLength = entry.prefixLength();
      if (localAddress.protocol() == targetAddress.protocol() &&
          prefixLength >= 0 &&
          targetAddress.isInSubnet(localAddress, prefixLength)) {
        return true;
      }
    }
  }

  return false;
}

///////////////////////////////////////////////////////////////////////////////////////////////////
QString SystemComponent::getUserAgent()
{
  QString kernel = QSysInfo::kernelType();
  kernel[0] = kernel[0].toUpper();
  QString chromeVersion = QString(qWebEngineChromiumVersion()).split('.').first() + ".0.0.0";
  QString userAgent = QString("TigerestTheater/%1 (%2; %3) Chrome/%4")
    .arg(Version::GetVersionString())
    .arg(kernel)
    .arg(getPlatformArchString())
    .arg(chromeVersion);
  return userAgent;
}

/////////////////////////////////////////////////////////////////////////////////////////
bool SystemComponent::setReportDiagnosticsScope(const QString& key)
{
  if(key.size() > 256) { Log::SetReportDiagnosticsScope(QString()); return false; }
  Log::SetReportDiagnosticsScope(key);
  return true;
}

QVariantMap SystemComponent::collectReportDiagnostics() const
{
  return Log::CollectReportDiagnostics();
}

///////////////////////////////////////////////////////////////////////////////////////////////////
QVariantMap SystemComponent::takeUnfinishedFault()
{
  return std::exchange(m_unfinishedFault, QVariantMap());
}

QString SystemComponent::debugInformation()
{
  QString debugInfo;
  QTextStream stream(&debugInfo);

  stream << "Jellyfin\n";
  stream << "  Version: " << Version::GetVersionString() << " built: " << Version::GetBuildDate() << "\n";
  stream << "  Web Client Version: " << Version::GetWebVersion() << "\n";
  stream << "  Web Client URL: " << SettingsComponent::Get().value(SETTINGS_SECTION_PATH, "startupurl").toString() << "\n";
  stream << "  Platform: " << getPlatformTypeString() << "-" << getPlatformArchString() << "\n";
  stream << "  User-Agent: " << getUserAgent() << "\n";
  stream << "  Qt version: " << qVersion() << QString("(%1)").arg(Version::GetQtDepsVersion()) << "\n";
  stream << "  Depends version: " << Version::GetDependenciesVersion() << "\n";
  stream << "\n";

  stream << "Files\n";
  stream << "  Log file: " << ProfileManager::activeProfile().logDir() + "/" + Names::DataName() + ".log" << "\n";
  stream << "  Config file: " << ProfileManager::activeProfile().dataDir(Names::DataName() + ".conf") << "\n";
  stream << "\n";

  stream << "Network Addresses\n";
  for(const QString& addr : networkAddresses())
  {
    stream << "  " << addr << "\n";
  }
  stream << "\n";

  stream.flush();
  return debugInfo;
}

/////////////////////////////////////////////////////////////////////////////////////////
QStringList SystemComponent::networkAddresses() const
{
  QStringList list;
  for(const QHostAddress& address : QNetworkInterface::allAddresses())
  {
    if (! address.isLoopback() && (address.protocol() == QAbstractSocket::IPv4Protocol ||
                                   address.protocol() == QAbstractSocket::IPv6Protocol))
    {
      auto s = address.toString();
      if (!s.startsWith("fe80::"))
        list << s;
    }
  }

  return list;
}

/////////////////////////////////////////////////////////////////////////////////////////
void SystemComponent::openExternalUrl(const QString& url)
{
  QDesktopServices::openUrl(QUrl(url));
}

void SystemComponent::openServerSettings()
{
  emit serverSettingsRequested();
}

bool SystemComponent::finishServerSelection(const QString& server, const QString& mode, const QString& target, const QString& history)
{
  // The remembered-server list is committed with a successful page load only.
  // Accept one bounded JSON document; its records are validated by the chooser.
  if (!history.isEmpty())
  {
    const QJsonDocument document = QJsonDocument::fromJson(history.toUtf8());
    if (history.size() > 32768 || !document.isObject() || !document.object().value("servers").isArray() ||
        document.object().value("servers").toArray().size() > 20)
      return false;
  }
  const QUrl source(server), destination(target);
  if (!source.isValid() || !destination.isValid() || source.host().isEmpty() ||
      (source.scheme() != "http" && source.scheme() != "https") ||
      !source.userInfo().isEmpty() || !destination.userInfo().isEmpty() ||
      source.scheme() != destination.scheme() || source.host() != destination.host() ||
      source.port(source.scheme() == "https" ? 443 : 80) != destination.port(destination.scheme() == "https" ? 443 : 80) ||
      (mode != "custom" && mode != "tigerest")) return false;
  emit serverSelectionFinished(server, mode, target, history);
  return true;
}

/////////////////////////////////////////////////////////////////////////////////////////
void SystemComponent::runUserScript(QString script)
{
  // We take the path the user supplied and run it through fileInfo and
  // look for the fileName() part, this is to avoid people sharing keymaps
  // that tries to execute things like ../../ etc. Note that this function
  // is still not safe, people can do nasty things with it, so users needs
  // to be careful with their keymaps.
  //
  QFileInfo fi(script);
  QString scriptPath = ProfileManager::activeProfile().dataDir("scripts/" + fi.fileName());

  QFile scriptFile(scriptPath);
  if (scriptFile.exists())
  {
    if (!QFileInfo(scriptFile).isExecutable())
    {
      qWarning() << "Script:" << script << "is not executable";
      return;
    }

    qInfo() << "Running script:" << scriptPath;

    if (QProcess::startDetached(scriptPath, QStringList()))
      qDebug() << "Script started successfully";
    else
      qWarning() << "Error running script:" << scriptPath;
  }
  else
  {
    qWarning() << "Could not find script:" << scriptPath;
  }
}

/////////////////////////////////////////////////////////////////////////////////////////
void SystemComponent::hello(const QString& version)
{
  qDebug() << QString("Web-client (%1) fully inited.").arg(version);
  m_webClientVersion = version;
  // Start after the first page load: startup work is not a stall to report.
  if (!m_watchdog->running() && m_watchdog->start(stallFaultFile()))
    qInfo() << "Main-thread watchdog started";
}

/////////////////////////////////////////////////////////////////////////////////////////
QString SystemComponent::getWebAppearanceScript()
{
  static QString cachedScript;
  if (!cachedScript.isEmpty()) {
    return cachedScript;
  }

  QFile file(":/web-client/extension/webAppearance.js");
  if (!file.open(QIODevice::ReadOnly)) {
    qCritical() << "Failed to load web appearance script from qrc";
    return "";
  }

  cachedScript = ";(function () {\n" + QTextStream(&file).readAll() + "\n}).call(window);\n";
  return cachedScript;
}

/////////////////////////////////////////////////////////////////////////////////////////
QString SystemComponent::getNativeShellScript()
{
  static QString cachedScript;
  if (!cachedScript.isEmpty()) {
    return cachedScript;
  }

  auto path = SettingsComponent::Get().getExtensionPath();
  qDebug() << QString("Using path for extension: %1").arg(path);

  QJsonObject clientData;
  clientData.insert("deviceName", QJsonValue::fromVariant(SettingsComponent::Get().getClientName()));
  clientData.insert("version", QJsonValue::fromVariant(Version::GetVersionString()));
  clientData.insert("userAgent", QJsonValue::fromVariant(getUserAgent()));
  clientData.insert("scriptPath", QJsonValue::fromVariant("file:///" + path));
  clientData.insert("homeArtPath", "qrc:///web-client/extension/home-art");
  QString defaultMode = SettingsComponent::Get().value(SETTINGS_SECTION_MAIN, "layout").toString();

  QFile flatpakOsFile {"/run/host/os-release"};
  if (flatpakOsFile.exists()) {
    qDebug() << "Found flatpak os-release file";
    if (flatpakOsFile.open(QIODevice::ReadOnly)) {
      QString flatpakOsFileString = QTextStream(&flatpakOsFile).readAll();
      if (flatpakOsFileString.contains("NAME=\"SteamOS\"")) {
        qDebug() << "Detected SteamOS";
        defaultMode = "tv";
      }
    }
  }
  clientData.insert("mode", QJsonValue::fromVariant(defaultMode));
  clientData.insert("mpvConfigDir", QJsonValue::fromVariant(MpvConfigManager::activeConfigDir()));
  clientData.insert("mpvConfNotices", QJsonValue::fromVariant(MpvConfigManager::notices()));

  QVariantList settingsDescriptionsList = SettingsComponent::Get().settingDescriptions();
  QVariantMap settingsDescriptions = QVariantMap();
  for (auto setting : settingsDescriptionsList) {
    QVariantMap settingMap = setting.toMap();
    settingsDescriptions.insert(settingMap["key"].toString(), settingMap["settings"]);
  }
  clientData.insert("sections", QJsonValue::fromVariant(SettingsComponent::Get().orderedSections()));
  clientData.insert("settingsDescriptions", QJsonValue::fromVariant(settingsDescriptions));
  clientData.insert("settings", QJsonValue::fromVariant(SettingsComponent::Get().allValues()));

  // Keep injected state on the Window object only.  A top-level const/let here
  // becomes part of the page's global lexical scope and can collide with the
  // Emby web client's AMD loader or application bundles.
  // atob() returns a byte string, not a Unicode string.  Passing UTF-8 JSON
  // from the settings descriptions straight to JSON.parse() therefore turns
  // Chinese labels into mojibake.  Decode the bytes explicitly before parse.
  QString jmpInfoDeclaration =
    "window.jmpInfo = JSON.parse(new TextDecoder('utf-8').decode(" 
    "Uint8Array.from(window.atob(\"" +
    QJsonDocument(clientData).toJson(QJsonDocument::Compact).toBase64() +
    "\"), c => c.charCodeAt(0))));\n";

  auto loadScript = [](const QString& scriptPath) -> QString {
    QFile file(scriptPath);
    if (!file.open(QIODevice::ReadOnly)) {
      qCritical() << "Failed to load" << scriptPath << "from qrc";
      return "";
    }
    return QTextStream(&file).readAll();
  };

  QStringList scriptPaths = {
    ":/qtwebchannel/qwebchannel.js",
    ":/web-client/extension/serverKind.js",
    ":/web-client/extension/mpvVideoPlayer.js",
    ":/web-client/extension/mpvAudioPlayer.js",
    ":/web-client/extension/inputPlugin.js",
    ":/web-client/extension/sessionNavigationPlugin.js",
    ":/web-client/extension/communityClient.js",
    ":/web-client/extension/communityBridge.js",
    ":/web-client/extension/communitySession.js",
    ":/web-client/extension/communityAvatar.js",
    ":/web-client/extension/communityPublicClient.js",
    ":/web-client/extension/communityAccount.js",
    ":/web-client/extension/communityMessages.js",
    ":/web-client/extension/faultReports.js",
    ":/web-client/extension/communityPlugin.js",
    ":/web-client/extension/watchTogetherClient.js",
    ":/web-client/extension/watchTogetherSync.js",
    ":/web-client/extension/watchTogether.js",
    ":/web-client/extension/jellyfinPlugin.js",
    ":/web-client/extension/updatePlugin.js",
    ":/web-client/extension/connectivityHelper.js",
    ":/web-client/extension/serverHistory.js",
    ":/web-client/extension/mpvConfEditor.js",
    ":/web-client/extension/nativeshell.js",
    ":/web-client/extension/offline.js",
    ":/web-client/extension/localPlayer.js",
    ":/web-client/extension/homeData.js",
    ":/web-client/extension/homeGallery.js",
    ":/web-client/extension/homeBackdrop.js",
    ":/web-client/extension/homeTransitions.js",
    ":/web-client/extension/homeMotion.js",
    ":/web-client/extension/embycompat.js"
  };
#ifdef Q_OS_MAC
  scriptPaths.append(":/web-client/extension/ambientBackdrop.js");
#endif

  cachedScript = jmpInfoDeclaration;
  for (const QString& scriptPath : scriptPaths) {
    const QString script = loadScript(scriptPath);
    if (scriptPath == ":/qtwebchannel/qwebchannel.js") {
      // qwebchannel.js intentionally exposes QWebChannel as a page global.
      cachedScript += script + "\n";
    } else {
      // Each native extension exports only its explicit window.* API.  Keeping
      // its implementation variables private prevents collisions with Emby's
      // loader and with future server-side bundles.
      cachedScript += ";(function () {\n" + script + "\n}).call(window);\n";
    }
  }

  return cachedScript;
}

/////////////////////////////////////////////////////////////////////////////////////////
void SystemComponent::fetchPageForCSPWorkaround(QString url)
{
  qDebug() << "fetchPageForCSPWorkaround:" << url;

  QNetworkRequest request(url);
  request.setHeader(QNetworkRequest::UserAgentHeader, getUserAgent());
  request.setRawHeader("Cache-Control", "no-cache");

  // Configure SSL settings
  QSslConfiguration sslConfig = request.sslConfiguration();
  if (SettingsComponent::Get().ignoreSSLErrors()) {
    qDebug() << "fetchPageForCSPWorkaround: ignoring SSL errors";
    sslConfig.setPeerVerifyMode(QSslSocket::VerifyNone);
  }
  request.setSslConfiguration(sslConfig);

  QNetworkReply* reply = m_networkManager->get(request);

  // Handle SSL errors if ignoreSSLErrors is enabled
  if (SettingsComponent::Get().ignoreSSLErrors()) {
    connect(reply, QOverload<const QList<QSslError>&>::of(&QNetworkReply::sslErrors),
            this, [reply](const QList<QSslError>& errors) {
      qDebug() << "fetchPageForCSPWorkaround: ignoring SSL errors:" << errors;
      reply->ignoreSslErrors();
    });
  }

  connect(reply, &QNetworkReply::finished, this, [this, reply, url]() {
    if (reply->error() == QNetworkReply::NoError) {
      QByteArray rawData = reply->readAll();
      QString html = QString::fromUtf8(rawData);
      QString finalUrl = reply->url().toString();
      bool hadCSP = false;

      // Check for CSP headers
      QList<QByteArray> headerList = reply->rawHeaderList();
      for (const QByteArray& header : headerList) {
        QString headerName = QString::fromUtf8(header);
        if (headerName.toLower() == "content-security-policy" ||
            headerName.toLower() == "content-security-policy-report-only") {
          hadCSP = true;
          QString headerValue = QString::fromUtf8(reply->rawHeader(header));
          qInfo() << "CSP header detected:" << headerName << "=" << headerValue.left(100);
        }
      }

      if (hadCSP) {
        qInfo() << "CSP workaround: applying for" << url;
      } else {
        qDebug() << "No CSP detected for" << url;
      }

      emit pageContentReady(html, finalUrl, hadCSP);
    } else {
      qCritical() << "fetchPageForCSPWorkaround: fetch failed:" << reply->errorString();
    }
    reply->deleteLater();
  });
}

/////////////////////////////////////////////////////////////////////////////////////////
void SystemComponent::checkForUpdates(bool manual)
{
  if (!m_appUpdater) return;
  bool enabled = SettingsComponent::Get().value(SETTINGS_SECTION_MAIN, "checkForUpdates").toBool();
#ifdef DISABLE_UPDATE_CHECK
  enabled = false;
#endif
  m_appUpdater->check(manual, enabled);
}

QVariantMap SystemComponent::appUpdateState() const { return m_appUpdater ? m_appUpdater->state() : QVariantMap(); }
void SystemComponent::downloadAppUpdate() { if (m_appUpdater) m_appUpdater->download(); }
void SystemComponent::installAppUpdate(bool automatic)
{
  if (!m_appUpdater) return;
  // An unattended install closes the app, so a download finishing mid-video waits for it to end.
  if (automatic && m_appUpdater->state().value("autoRestart").toBool() && PlayerComponent::Get().inPlayback())
  {
    if (!m_installAfterPlayback)
    {
      m_installAfterPlayback = new QTimer(this);
      m_installAfterPlayback->setInterval(5000);
      connect(m_installAfterPlayback, &QTimer::timeout, this, [this] {
        if (PlayerComponent::Get().inPlayback()) return;
        m_installAfterPlayback->stop();
        m_appUpdater->install(true);
      });
    }
    m_installAfterPlayback->start();
    return;
  }
  m_appUpdater->install(automatic);
}
void SystemComponent::cancelAppUpdate() { if (m_appUpdater) m_appUpdater->cancel(); }
void SystemComponent::skipAppUpdate() { if (m_appUpdater) m_appUpdater->skip(); }
void SystemComponent::deferAppUpdate() { if (m_appUpdater) m_appUpdater->defer(); }
void SystemComponent::openAppUpdateMirror(const QString& kind) { if (m_appUpdater) m_appUpdater->openMirror(kind); }

/////////////////////////////////////////////////////////////////////////////////////////
#define BASESTR "protocols=shoutcast,http-video;videoDecoders=h264{profile:high&resolution:2160&level:52};audioDecoders=mp3,aac,dts{bitrate:800000&channels:%1},ac3{bitrate:800000&channels:%2}"

/////////////////////////////////////////////////////////////////////////////////////////
QString SystemComponent::getCapabilitiesString()
{
  auto capstring = QString(BASESTR);
  auto channels = SettingsComponent::Get().value(SETTINGS_SECTION_AUDIO, "channels").toString();
  auto dtsenabled = SettingsComponent::Get().value(SETTINGS_SECTION_AUDIO, "passthrough.dts").toBool();
  auto ac3enabled = SettingsComponent::Get().value(SETTINGS_SECTION_AUDIO, "passthrough.ac3").toBool();

  // Assume that auto means that we want to select multi-channel tracks by default.
  // So really only disable it when 2.0 is selected.
  //
  int ac3channels = 2;
  int dtschannels = 2;

  if (channels != "2.0")
    dtschannels = ac3channels = 8;
  else if (dtsenabled)
    dtschannels = 8;
  else if (ac3enabled)
    ac3channels = 8;

  return capstring.arg(dtschannels).arg(ac3channels);
}

void SystemComponent::communityRequest(const QString& id, const QVariantMap& request) { m_communityBridge->request(id, request); }
void SystemComponent::communitySourceAvatar(const QString& id, const QVariantMap& session) { m_communityBridge->sourceAvatar(id, session); }
void SystemComponent::communityCancel(const QString& id) { m_communityBridge->cancel(id); }
QVariantMap SystemComponent::communityCredential(const QString& operation, const QString& key, const QString& value) { return m_communityBridge->credential(operation, key, value); }
bool SystemComponent::communitySetEmbySession(const QVariantMap& session) { return m_communityBridge->setEmbySession(session); }
QString SystemComponent::communityMappingAuthFile() const { return m_communityBridge->mappingAuthFile(); }
QString SystemComponent::communityAuthGeneration() const { return m_communityBridge->authGeneration(); }
