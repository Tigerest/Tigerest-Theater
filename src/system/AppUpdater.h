#pragma once

#include "AppUpdatePolicy.h"
#include <QObject>
#include <QVariantMap>
#include <QPointer>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QFile>
#include <QList>
#include <QTimer>
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
  // Waits before each automatic resume of an interrupted package download.
  // Only consecutive attempts that receive no new bytes consume an entry.
  void setRetryDelays(const QList<int>& milliseconds);
signals:
  void changed(const QVariantMap& state);
private:
  void publish(const QString& status, const QString& error = {});
  void request(const QUrl& url, bool metadata, int redirects = 0);
  void requestPackage();
  bool acceptPackage(QNetworkReply* reply, int status);
  void receive(QNetworkReply* reply, bool metadata);
  void finish(QNetworkReply* reply, bool metadata, int redirects);
  void retryPackage();
  void fail(const QString& message);
  void stopTransfer();
  void clearTransfer();
  void removeStalePartials() const;
  QString packageDirectory() const;
  QString skippedVersion() const;
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
  QTimer m_retryTimer;
  QList<int> m_retryDelays{2000, 5000, 10000, 20000, 30000};
  int m_failedAttempts = 0;
  qint64 m_attemptStart = 0;
  bool m_packageAccepted = false;
  bool m_automaticAttempted = false;
  bool m_packageOpened = false;
};
