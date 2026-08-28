#ifndef TIGEREST_MPVCONFIGMANAGER_H
#define TIGEREST_MPVCONFIGMANAGER_H

#include <QString>

namespace MpvConfigManager
{
  bool prepare();
  QString activeConfigDir();
  bool usingSystemConfig();
  QString detectSystemConfigDir(const QString& configuredPath = QString());
  QString profileName(const QString& preset);
}

#endif
