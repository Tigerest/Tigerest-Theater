#ifndef PLAYBACKIDENTITY_H
#define PLAYBACKIDENTITY_H

#include <QString>
#include <QVariantMap>

namespace Tigerest
{

struct PlaybackIdentity
{
  QString mediaTitle;
  QString itemId;
  QString seriesName;
  QString episodeName;
  int seasonNumber = -1;
  int episodeNumber = -1;
  bool validEpisode = false;
};

PlaybackIdentity makePlaybackIdentity(const QVariantMap& item);

}

#endif // PLAYBACKIDENTITY_H
