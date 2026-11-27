#ifndef TIGEREST_MPVCONFIGMANAGER_H
#define TIGEREST_MPVCONFIGMANAGER_H

#include "MpvConfDocument.h"

#include <QJsonObject>
#include <QList>
#include <QString>
#include <QStringList>
#include <QVariant>
#include <QVariantMap>

// Owns the managed mpv root: the bundled resources, the single user-editable
// mpv.conf and its read-only managed head and tail.
namespace MpvConfigManager
{
  bool prepare();
  void configureBundledVulkan(const QString& executableDirectory);
  void configureVapourSynth(const QStringList& installationRoots);
  bool configureBundledVapourSynth(const QString& executableDirectory,const QString& registrationDirectory,bool preferBundled=false);
  QString activeConfigDir();
  QString userConfigPath();
  // The key map mpv reads. mpv's --input-conf takes a single file, so the
  // bundled bindings are its default block (rewritten on every start) and the
  // user's own bindings follow them as the user block (kept verbatim).
  QString inputConfPath();
  QString defaultKeymap();
  QString userKeymap();
  QVariantMap saveUserKeymap(const QString& user, QString* errorMessage = nullptr);
  bool userKeymapHasBinding(const QString& key);
  QString shaderDir();
  QString userShaderDir();
  bool ownsDefaultSvpIpc();
  // Settings value of the quality preset <-> mpv profile name. User-defined
  // profiles (tigerest-user-*) are stored by their own name.
  QString profileName(const QString& preset);
  QString presetForProfile(const QString& profile);
  // The profile mpv starts with: the preset's, falling back to the default.
  QString startupProfile(const QString& user);
  QString danmakuApiServer(const QString& serverUrl, const QString& connectionMode);
  QString danmakuStyleConfigText(const QVariantMap& values);
  bool writeDanmakuStyleConfig(const QString& configDir,
                               const QVariantMap& values,
                               QString* errorMessage = nullptr);

  // Options another settings page decides. The player applies them live and
  // the managed tail of mpv.conf shows the same values.
  struct ManagedOption
  {
    QString key;
    QVariant value;
    QString comment;
  };
  QList<ManagedOption> videoOptions();
  QList<ManagedOption> subtitleOptions();
  QList<ManagedOption> audioOptions();
  QString optionText(const QVariant& value);

  const MpvConf::Rules& rules();
  // Replaces the cached libmpv option table with the running player's.
  void storeOptionTable(const QJsonObject& table);
  QString cachedOptionTableVersion();
  QVariantMap settingsContext();
  MpvConf::ValidationContext validationContext();
  QString defaultUser();
  MpvConf::Parts readConfig();

  struct WriteResult
  {
    bool ok = false;
    QString user;
    QStringList suspended;
    QStringList restored;
    QStringList ignored;
  };
  // Rewrites the managed blocks around the stored user area, re-applying the
  // RIFE suspension. Called at startup and whenever a deciding setting changes.
  WriteResult refresh();
  // Stores an edited user area (from the settings-page editor).
  WriteResult saveUser(const QString& user);
  WriteResult restoreDefault();
  bool defaultUpdated();
  void acknowledgeDefaultUpdate();
  QString backupPath();
  QVariantList missingShaders();
  QVariantList notices();
  void addNotice(const QString& kind, const QString& title, const QString& message);
  QString aiGuide();
  QString aiGuidePath();
}

#endif
