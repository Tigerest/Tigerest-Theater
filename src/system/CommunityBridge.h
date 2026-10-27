#pragma once
#include <QObject>
#include <QVariantMap>
#include <QNetworkAccessManager>
#include <QPointer>
#include <QTemporaryFile>
#include <QSet>
#include <memory>

class CommunityBridge : public QObject
{
  Q_OBJECT
public:
  explicit CommunityBridge(QObject* parent = nullptr);
  void request(const QString& id, const QVariantMap& request);
  void sourceAvatar(const QString& id, const QVariantMap& session);
  void cancel(const QString& id);
  QVariantMap credential(const QString& operation, const QString& key, const QString& value);
  bool setEmbySession(const QVariantMap& session);
  QString mappingAuthFile() const;
  QString authGeneration() const;
  static bool allowed(const QVariantMap& request, const QString& trustedServer);
  // Self-reported build details the comment, room and danmaku services record.
  static QVariantMap clientHeaders();
signals:
  void response(const QString& id, const QVariantMap& result);
  void mappingAuthChanged(const QString& path, const QString& generation);
private:
  void refreshMappingAuth();
  void fetchSourceAvatar(const QString& id, const QVariantMap& session, bool image, qint64 deadline);
  QNetworkAccessManager m_network;
  QHash<QString,QPointer<QNetworkReply>> m_pending;
  QSet<QString> m_sourceIds;
  QString m_trustedServer;
  QVariantMap m_emby;
  int m_mappingCapabilitiesStatus = 0;
  QString m_mappingCapabilitiesRequest;
  QString m_rejectedEmbyToken;
  bool m_legacyAuth = false;
  std::unique_ptr<QTemporaryFile> m_authFile;
  quint64 m_generation = 0;
};
