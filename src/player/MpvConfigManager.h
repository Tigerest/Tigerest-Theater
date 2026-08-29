#ifndef TIGEREST_MPVCONFIGMANAGER_H
#define TIGEREST_MPVCONFIGMANAGER_H

#include <QString>
#include <QVariantMap>

namespace MpvConfigManager
{
  bool prepare();
  QString activeConfigDir();
  bool usingSystemConfig();
  QString detectSystemConfigDir(const QString& configuredPath = QString());
  QString profileName(const QString& preset);
  QString danmakuStyleConfigText(const QVariantMap& values);
  QString danmakuStyleMpvOptionsText(const QVariantMap& values);
  bool writeDanmakuStyleConfig(const QString& configDir,
                               const QVariantMap& values,
                               QString* errorMessage = nullptr);
}

#endif
