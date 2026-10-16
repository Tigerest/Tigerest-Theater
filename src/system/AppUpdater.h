#pragma once

#include "AppUpdatePolicy.h"
#include <QObject>
#include <QVariantMap>
#include <QPointer>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QFile>
#include <QTimer>
#include <QElapsedTimer>
#include <QLockFile>
#include <memory>
#include <functional>

// Only native code supplies configuration, transport and a package launcher.
// The WebChannel surface forwards parameterless actions to this owner.
class AppUpdater : public QObject
{
  Q_OBJECT
public:
  using Launcher = std::function<bool(const QString&, AppUpdatePolicy::Package)>;
  AppUpdater(const QString& currentVersion, AppUpdatePolicy::Package package,
             const QString& cacheDirectory, const QString& preferencePath,
             QNetworkAccessManager* network, Launcher launcher, QObject* parent = nullptr);
  ~AppUpdater() override;
  QVariantMap state() const;
  void check(bool manual, bool enabled);
  void download();
  void install(bool automatic = false);
  void cancel();
  void skip();
  void defer();
signals:
  void changed(const QVariantMap& state);
private:
  void publish(const QString& status, const QString& error = {});
  void request(const QUrl& url, bool metadata, int redirects = 0);
  void receive(QNetworkReply* reply, bool metadata);
  void finish(QNetworkReply* reply, bool metadata, int redirects);
  void fail(const QString& message, bool discard = false);
  void clearTransfer(bool discard = false);
  bool acceptDownloadHeaders(QNetworkReply* reply);
  bool saveDownloadMetadata();
  bool restoreDownloadMetadata();
  void refreshCachedProgress();
  void beginDownloadRequest();
  void completeDownload();
  void retryDownload(const QString& message);
  void restartDownload();
  QString skippedVersion() const;
  void checkReleaseManifest(QNetworkReply* reply, int status);
  // The API release list, then the release page and manifest when it is rate limited.
  enum class Source { Api, LatestRelease, Manifest };
  const QString m_currentVersion;
  const AppUpdatePolicy::Package m_package;
  const QString m_cacheDirectory;
  const QString m_preferencePath;
  QNetworkAccessManager* m_network;
  Launcher m_launcher;
  QPointer<QNetworkReply> m_reply;
  QFile m_file;
  QByteArray m_metadata;
  AppUpdatePolicy::Candidate m_candidate;
  QVariantMap m_state;
  QString m_downloadDirectory;
  QString m_readyPath;
  QString m_metadataPath;
  QByteArray m_etag;
  std::unique_ptr<QLockFile> m_cacheLock;
  QTimer m_retryTimer;
  QElapsedTimer m_transferClock;
  QElapsedTimer m_progressClock;
  qint64 m_requestOffset = 0;
  qint64 m_progressHighWater = 0;
  int m_retryCount = 0;
  bool m_headersAccepted = false;
  bool m_restartedFresh = false;
  bool m_automaticAttempted = false;
  bool m_packageOpened = false;
  Source m_source = Source::Api;
  QString m_fallbackTag;
};
