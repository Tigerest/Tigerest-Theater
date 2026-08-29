#include "PlaybackIdentity.h"

namespace
{

bool readNonNegativeInteger(const QVariantMap& item, const QString& key, int& result)
{
  const QVariant value = item.value(key);
  if (!value.isValid() || value.isNull())
    return false;

  bool ok = false;
  const int number = value.toInt(&ok);
  if (!ok || number < 0)
    return false;

  result = number;
  return true;
}

QString episodeCode(int seasonNumber, int episodeNumber)
{
  const QString episode = QStringLiteral("E%1").arg(episodeNumber, 2, 10, QLatin1Char('0'));
  if (seasonNumber < 0)
    return episode;
  return QStringLiteral("S%1%2").arg(seasonNumber, 2, 10, QLatin1Char('0')).arg(episode);
}

}

namespace Tigerest
{

PlaybackIdentity makePlaybackIdentity(const QVariantMap& item)
{
  PlaybackIdentity identity;
  identity.itemId = item.value(QStringLiteral("Id")).toString().trimmed();
  identity.seriesName = item.value(QStringLiteral("SeriesName")).toString().trimmed();
  identity.episodeName = item.value(QStringLiteral("Name")).toString().trimmed();

  int episodeNumber = -1;
  const bool hasEpisode = readNonNegativeInteger(item, QStringLiteral("IndexNumber"), episodeNumber);
  int seasonNumber = -1;
  const bool hasSeason = readNonNegativeInteger(item, QStringLiteral("ParentIndexNumber"), seasonNumber);
  const bool isEpisode = item.value(QStringLiteral("Type")).toString()
                           .compare(QStringLiteral("Episode"), Qt::CaseInsensitive) == 0;

  identity.validEpisode = isEpisode && !identity.seriesName.isEmpty() && hasEpisode;
  if (identity.validEpisode)
  {
    identity.episodeNumber = episodeNumber;
    identity.seasonNumber = hasSeason ? seasonNumber : -1;
    identity.mediaTitle = identity.seriesName + QLatin1Char(' ')
                          + episodeCode(identity.seasonNumber, identity.episodeNumber);
    if (!identity.episodeName.isEmpty())
      identity.mediaTitle += QStringLiteral(" - ") + identity.episodeName;
  }
  else
  {
    identity.mediaTitle = identity.episodeName;
  }

  return identity;
}

}
