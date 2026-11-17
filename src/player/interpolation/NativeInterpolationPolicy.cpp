#include "NativeInterpolationPolicy.h"
#include <QLocale>
#include <QStringList>
#include <cmath>

namespace native {
Mode modeFromSetting(const QString& setting)
{
  if (setting == QLatin1String("quality"))
    return Mode::Quality;
  if (setting == QLatin1String("efficient"))
    return Mode::Efficient;
  return Mode::Off;
}

QString modeName(Mode mode)
{
  switch (mode)
  {
    case Mode::Quality: return QStringLiteral("quality");
    case Mode::Efficient: return QStringLiteral("efficient");
    default: return QStringLiteral("off");
  }
}

QString filterText(Mode mode, const QString& target, double displayFps)
{
  if (mode == Mode::Off)
    return {};
  QString rate = QStringLiteral("factor=2");
  if (target == QLatin1String("60"))
    rate = QStringLiteral("target=60");
  // A screen slower than 48 Hz cannot show more than twice 24 fps.
  else if (target == QLatin1String("display") && std::isfinite(displayFps) && displayFps >= 48 && displayFps <= 600)
    rate = QStringLiteral("target=") + QString::number(std::lround(displayFps));
  return QStringLiteral("@%1:%1=mode=%2:%3").arg(QLatin1String(FilterLabel), modeName(mode), rate);
}

QString hardwareDecoding(const QString& current)
{
  if (current == QLatin1String("auto-copy") || current == QLatin1String("videotoolbox-copy") ||
      current == QLatin1String("auto-copy-safe"))
    return QStringLiteral("auto");
  return {};
}

QString notice(const QString& status)
{
  if (status == QLatin1String("unsupported-size"))
    return QStringLiteral("当前分辨率保持原帧播放（原生补帧最高 1080p）");
  if (status == QLatin1String("unsupported-fps"))
    return QStringLiteral("当前帧率保持原帧播放（原生补帧最高 30 fps）");
  if (status == QLatin1String("hdr"))
    return QStringLiteral("HDR 视频保持原帧播放");
  if (status == QLatin1String("interlaced"))
    return QStringLiteral("隔行视频保持原帧播放");
  if (status == QLatin1String("needs-hardware-frames"))
    return QStringLiteral("原生补帧需要硬件解码（设置 → 视频 → 硬件解码），当前保持原帧播放");
  if (status == QLatin1String("unavailable"))
    return QStringLiteral("这台 Mac 不支持所选的原生补帧方式，保持原帧播放");
  if (status == QLatin1String("too-slow"))
    return QStringLiteral("原生补帧跟不上播放，本集已恢复原帧；可以改用低功耗模式或 2 倍");
  if (status == QLatin1String("fallback-efficient"))
    return QStringLiteral("画质优先的原生补帧跟不上播放，本集改用低功耗方式");
  if (status == QLatin1String("failed"))
    return QStringLiteral("原生补帧出错，本集已恢复原帧播放");
  return {};
}

static double number(const QVariantMap& map, const char* key)
{
  bool ok = false;
  const double value = map.value(QLatin1String(key)).toString().toDouble(&ok);
  return ok && std::isfinite(value) ? value : 0;
}

QVariantMap diagnostics(const QVariantMap& metadata, const QString& filter)
{
  if (filter.isEmpty())
    return {{QStringLiteral("active"), false}};
  const QString status = metadata.value(QStringLiteral("status")).toString();
  const bool fellBack = metadata.value(QStringLiteral("fallback")).toString() == QLatin1String("efficient");
  static const QStringList counters = {QStringLiteral("inputs"), QStringLiteral("outputs"), QStringLiteral("generated"),
                                       QStringLiteral("held"), QStringLiteral("statics"), QStringLiteral("cuts"),
                                       QStringLiteral("bypassed"), QStringLiteral("failures"), QStringLiteral("pairs")};
  QVariantMap result{{QStringLiteral("active"), true},
                     {QStringLiteral("filter"), filter},
                     {QStringLiteral("status"), status.isEmpty() ? QStringLiteral("waiting") : status},
                     {QStringLiteral("mode"), metadata.value(QStringLiteral("mode"))},
                     {QStringLiteral("sourceFps"), number(metadata, "sourceFps")},
                     {QStringLiteral("outputFps"), number(metadata, "outputFps")},
                     {QStringLiteral("processMs"), number(metadata, "processMs")},
                     {QStringLiteral("processP95Ms"), number(metadata, "processP95Ms")},
                     {QStringLiteral("error"), metadata.value(QStringLiteral("error"))},
                     {QStringLiteral("fellBack"), fellBack}};
  for (const QString& key : counters)
    result.insert(key, qlonglong(number(metadata, key.toLatin1().constData())));
  return result;
}
}
