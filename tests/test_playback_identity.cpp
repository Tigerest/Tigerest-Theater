#include <QtTest/QtTest>

#include "../src/player/PlaybackIdentity.h"

class TestPlaybackIdentity : public QObject
{
  Q_OBJECT

private slots:
  void episodeUsesSeriesSeasonEpisodeAndName();
  void seasonlessEpisodeUsesEpisodeOnly();
  void movieUsesItemName();
  void punctuationAndZeroIndexesArePreserved();
  void missingMetadataProducesNoForcedIdentity();
};

void TestPlaybackIdentity::episodeUsesSeriesSeasonEpisodeAndName()
{
  const QVariantMap item{
    {QStringLiteral("Type"), QStringLiteral("Episode")},
    {QStringLiteral("Id"), QStringLiteral("72857")},
    {QStringLiteral("SeriesName"), QStringLiteral("葬送的芙莉莲")},
    {QStringLiteral("Name"), QStringLiteral("杀人魔法")},
    {QStringLiteral("ParentIndexNumber"), 1},
    {QStringLiteral("IndexNumber"), 3},
  };

  const Tigerest::PlaybackIdentity identity = Tigerest::makePlaybackIdentity(item);

  QCOMPARE(identity.mediaTitle, QStringLiteral("葬送的芙莉莲 S01E03 - 杀人魔法"));
  QVERIFY(identity.validEpisode);
  QCOMPARE(identity.itemId, QStringLiteral("72857"));
  QCOMPARE(identity.seriesName, QStringLiteral("葬送的芙莉莲"));
  QCOMPARE(identity.episodeName, QStringLiteral("杀人魔法"));
  QCOMPARE(identity.seasonNumber, 1);
  QCOMPARE(identity.episodeNumber, 3);
};

void TestPlaybackIdentity::seasonlessEpisodeUsesEpisodeOnly()
{
  const QVariantMap item{
    {QStringLiteral("Type"), QStringLiteral("Episode")},
    {QStringLiteral("SeriesName"), QStringLiteral("葬送的芙莉莲")},
    {QStringLiteral("Name"), QStringLiteral("杀人魔法")},
    {QStringLiteral("IndexNumber"), 3},
  };

  const Tigerest::PlaybackIdentity identity = Tigerest::makePlaybackIdentity(item);

  QCOMPARE(identity.mediaTitle, QStringLiteral("葬送的芙莉莲 E03 - 杀人魔法"));
  QVERIFY(identity.validEpisode);
  QCOMPARE(identity.seasonNumber, -1);
  QCOMPARE(identity.episodeNumber, 3);
};

void TestPlaybackIdentity::movieUsesItemName()
{
  const QVariantMap item{
    {QStringLiteral("Type"), QStringLiteral("Movie")},
    {QStringLiteral("Name"), QStringLiteral("千与千寻")},
  };

  const Tigerest::PlaybackIdentity identity = Tigerest::makePlaybackIdentity(item);

  QCOMPARE(identity.mediaTitle, QStringLiteral("千与千寻"));
  QVERIFY(!identity.validEpisode);
};

void TestPlaybackIdentity::punctuationAndZeroIndexesArePreserved()
{
  const QVariantMap item{
    {QStringLiteral("Type"), QStringLiteral("Episode")},
    {QStringLiteral("SeriesName"), QStringLiteral("命运石之门, 0")},
    {QStringLiteral("Name"), QStringLiteral("序章=开始\\结束")},
    {QStringLiteral("ParentIndexNumber"), 0},
    {QStringLiteral("IndexNumber"), 0},
  };

  const Tigerest::PlaybackIdentity identity = Tigerest::makePlaybackIdentity(item);

  QCOMPARE(identity.mediaTitle,
           QStringLiteral("命运石之门, 0 S00E00 - 序章=开始\\结束"));
  QVERIFY(identity.validEpisode);
  QCOMPARE(identity.seasonNumber, 0);
  QCOMPARE(identity.episodeNumber, 0);
};

void TestPlaybackIdentity::missingMetadataProducesNoForcedIdentity()
{
  const Tigerest::PlaybackIdentity identity = Tigerest::makePlaybackIdentity({});

  QVERIFY(identity.mediaTitle.isEmpty());
  QVERIFY(!identity.validEpisode);
  QCOMPARE(identity.seasonNumber, -1);
  QCOMPARE(identity.episodeNumber, -1);
};

QTEST_GUILESS_MAIN(TestPlaybackIdentity)

#include "test_playback_identity.moc"
