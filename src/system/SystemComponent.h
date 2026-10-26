#ifndef __SYSTEM_COMPONENT_H__
#define __SYSTEM_COMPONENT_H__

#include "ComponentManager.h"
#include <QTimer>
#include <QNetworkReply>
#include <QNetworkAccessManager>
#include <QJSValue>
#include <QHash>
#include <QPointer>
#include <QFile>
#include <QUrl>
#include "utils/Utils.h"
#include "Paths.h"
#include "Names.h"

// System modifiers
#define SYSTEM_MODIFIER_OPENELEC "OpenELEC"

// Network timeouts (milliseconds)
constexpr int NETWORK_REQUEST_TIMEOUT_MS = 30000;
constexpr int CONNECTIVITY_REQUEST_TIMEOUT_MS = 5000;

class AppUpdater;
class CommunityBridge;
class MainThreadWatchdog;

class SystemComponent : public ComponentBase
{
  Q_OBJECT
  DEFINE_SINGLETON(SystemComponent);

public:
  Q_PROPERTY(bool isMacos READ platformIsMac CONSTANT)
  Q_PROPERTY(bool isWindows READ platformIsWindows CONSTANT)
  Q_PROPERTY(bool isLinux READ platformIsLinux CONSTANT)
  Q_PROPERTY(bool isFreeBSD READ platformIsFreeBSD CONSTANT)
  Q_PROPERTY(qreal scale MEMBER m_scale CONSTANT)

  bool componentExport() override { return true; }
  const char* componentName() override { return "system"; }
  bool componentInitialize() override;
  void componentPostInitialize() override;

  Q_INVOKABLE QVariantMap systemInformation() const;
  Q_INVOKABLE void exit();
  Q_INVOKABLE static void restart();

  Q_INVOKABLE void jsLog(int level, QString text);

  Q_INVOKABLE void checkServerConnectivity(QString url);
  Q_INVOKABLE void cancelServerConnectivity();
  Q_SIGNAL void serverConnectivityResult(QString url, bool success, QString resolvedUrl, QString errorMessage);
  Q_INVOKABLE bool isAddressOnLocalSubnet(const QString& address) const;

  static QString extractBaseUrl(const QString& url);
  void resolveUrl(const QString& url, std::function<void(const QString&)> callback,
                  int timeoutMs = NETWORK_REQUEST_TIMEOUT_MS);

  Q_INVOKABLE QString getUserAgent();

  Q_INVOKABLE QString debugInformation();
  Q_INVOKABLE void communityRequest(const QString& id, const QVariantMap& request);
  Q_INVOKABLE void communitySourceAvatar(const QString& id, const QVariantMap& session);
  Q_INVOKABLE void communityCancel(const QString& id);
  Q_INVOKABLE QVariantMap communityCredential(const QString& operation, const QString& key, const QString& value);
  Q_INVOKABLE bool communitySetEmbySession(const QVariantMap& session);
  Q_SIGNAL void communityResponse(const QString& id, const QVariantMap& result);
  QString communityMappingAuthFile() const;
  QString communityAuthGeneration() const;
  Q_INVOKABLE bool setReportDiagnosticsScope(const QString& key);
  Q_INVOKABLE QVariantMap collectReportDiagnostics() const;
  // Main-thread stalls for automatic fault reports. The unfinished fault is the
  // one a previous process never recovered from; it is returned once.
  Q_INVOKABLE QVariantMap takeUnfinishedFault();
  Q_SIGNAL void mainThreadStallRecovered(const QVariantMap& fault);

  Q_INVOKABLE QStringList networkAddresses() const;

  Q_INVOKABLE void openExternalUrl(const QString& url);
  Q_INVOKABLE void openServerSettings();
  Q_SIGNAL void serverSettingsRequested();
  Q_INVOKABLE bool finishServerSelection(const QString& server, const QString& mode, const QString& target, const QString& history);
  Q_SIGNAL void serverSelectionFinished(const QString& server, const QString& mode, const QString& target, const QString& history);
  Q_INVOKABLE void markServerSelectionError() { m_serverSelectionError = true; }
  Q_INVOKABLE bool takeServerSelectionError() { const bool failed = m_serverSelectionError; m_serverSelectionError = false; return failed; }

  // Native download/offline library API. Source URLs and authorization data are
  // kept in memory only; the persistent index contains local metadata only.
  Q_INVOKABLE QString startDownload(const QVariantMap& downloadInfo);
  Q_INVOKABLE void pauseDownload(const QString& id);
  Q_INVOKABLE void resumeDownload(const QString& id);
  Q_INVOKABLE void cancelDownload(const QString& id);
  Q_INVOKABLE void removeDownload(const QString& id);
  Q_INVOKABLE QVariantList downloads() const;
  Q_INVOKABLE QVariantMap downloadInfo(const QString& id) const;
  Q_INVOKABLE QString downloadsDirectory() const;

  // Local video files from the command line, a later launch or the file
  // dialog. Launches arriving together (Explorer starts one per selected file)
  // form one batch; the page takes it once the batch is complete.
  void openLocalFiles(const QStringList& files, bool atStartup = false);
  Q_INVOKABLE QVariantList takeLocalFiles();
  Q_INVOKABLE bool startedWithLocalFiles() const { return m_startedWithLocalFiles; }
  Q_INVOKABLE bool chooseLocalFiles();
  Q_SIGNAL void localFilesRequested();

  Q_INVOKABLE void runUserScript(QString script);

  Q_INVOKABLE QString getNativeShellScript();
  Q_INVOKABLE QString getWebAppearanceScript();

  Q_INVOKABLE void fetchPageForCSPWorkaround(QString url);
  Q_SIGNAL void pageContentReady(QString html, QString finalUrl, bool hadCSP);

  Q_INVOKABLE void checkForUpdates(bool manual = false);
  Q_INVOKABLE QVariantMap appUpdateState() const;
  Q_INVOKABLE void downloadAppUpdate();
  Q_INVOKABLE void installAppUpdate(bool automatic = false);
  Q_INVOKABLE void cancelAppUpdate();
  Q_INVOKABLE void skipAppUpdate();
  Q_INVOKABLE void deferAppUpdate();
  Q_INVOKABLE void openAppUpdateMirror(const QString& kind);
  Q_SIGNAL void appUpdateChanged(const QVariantMap& state);

  // called by the web-client when everything is properly inited
  Q_INVOKABLE void hello(const QString& version);

  Q_INVOKABLE QString getCapabilitiesString();
  Q_SIGNAL void capabilitiesChanged(const QString& capabilities);
  Q_SIGNAL void userInfoChanged();

  Q_SIGNAL void updateInfoEmitted(QString url);

  // possible os types type enum
  enum PlatformType
  {
    platformTypeUnknown,
    platformTypeOsx,
    platformTypeWindows,
    platformTypeLinux,
    platformTypeOpenELEC,
    platformTypeFreeBSD
  };

  // possible values for target types
  enum PlatformArch
  {
    platformArchUnknown,
    platformArchX86_32,
    platformArchX86_64,
    platformArchRpi2
  };

  inline PlatformType getPlatformType() { return m_platformType; }
  inline PlatformArch getPlatformArch() { return m_platformArch; }

  QString getPlatformTypeString() const;
  QString getPlatformArchString() const;

  inline bool isOpenELEC() const { return m_platformType == platformTypeOpenELEC; }
  bool isWebClientConnected() const { return !m_webClientVersion.isEmpty(); }

  inline QString authenticationToken() { return m_authenticationToken; }

  Q_INVOKABLE void crashApp();

  void updateScale(qreal scale);

  QSslConfiguration getSSLConfiguration();

signals:
  void hostMessage(const QString& message);
  void settingsMessage(const QString& setting, const QString& value);
  void downloadsChanged(const QVariantList& downloads);
  void scaleChanged(qreal scale);

private:
  explicit SystemComponent(QObject* parent = nullptr);
  static QMap<QString, QString> networkInterfaces();

  bool platformIsWindows() const { return m_platformType == platformTypeWindows; }
  bool platformIsMac() const { return m_platformType == platformTypeOsx; }
  bool platformIsLinux() const { return m_platformType == platformTypeLinux; }
  bool platformIsFreeBSD() const { return m_platformType == platformTypeFreeBSD; }

  void setReplyTimeout(QNetworkReply* reply, int ms);
  void checkServerBase(const QString& url, const QString& base, bool discoverPath, quint64 generation);
  void loadDownloadIndex();
  void saveDownloadIndex() const;
  void startDownloadRequest(const QString& id, const QUrl& url, bool resume);
  void emitDownloadsChanged();

  struct ActiveDownload
  {
    QPointer<QNetworkReply> reply;
    QPointer<QFile> file;
    bool paused = false;
    bool canceled = false;
  };

  QNetworkAccessManager* m_networkManager;
  AppUpdater* m_appUpdater = nullptr;
  QTimer* m_installAfterPlayback = nullptr;
#ifdef Q_OS_WIN
  class InstallerHandoff* m_installerHandoff = nullptr;
#endif
  CommunityBridge* m_communityBridge = nullptr;
  MainThreadWatchdog* m_watchdog = nullptr;
  QVariantMap m_unfinishedFault;
  PlatformType m_platformType;
  PlatformArch m_platformArch;
  bool m_doLogMessages;
  QString m_authenticationToken;
  QString m_webClientVersion;
  qreal m_scale;
  QNetworkReply* m_connectivityCheckReply;
  QNetworkReply* m_resolveUrlReply;
  quint64 m_connectivityGeneration = 0;
  bool m_serverSelectionError = false;
  QHash<QString, QVariantMap> m_downloads;
  QHash<QString, QUrl> m_downloadUrls;
  QHash<QString, ActiveDownload*> m_activeDownloads;
  QStringList m_localFiles;
  QTimer m_localFilesBatch;
  bool m_startedWithLocalFiles = false;
  QPointer<QObject> m_localFileDialog;
  QString m_localFileDirectory;

};

#endif
