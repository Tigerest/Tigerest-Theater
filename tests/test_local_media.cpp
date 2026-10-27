#include <QtTest>
#include <QDir>
#include <QFile>
#include <QTemporaryDir>
#include <QUrl>
#include "system/LocalMedia.h"

static QString touch(const QDir& dir, const QString& name)
{
  QFile file(dir.filePath(name));
  file.open(QIODevice::WriteOnly);
  file.write("x");
  return QDir::toNativeSeparators(QFileInfo(file).absoluteFilePath());
}

class TestLocalMedia : public QObject
{
  Q_OBJECT
private slots:
  void keepsExistingFilesInOrder()
  {
    QTemporaryDir root;
    QDir dir(root.path());
    dir.mkdir("folder");
    const QString first = touch(dir, QStringLiteral("测试 视频 [01].mkv"));
    const QString second = touch(dir, QStringLiteral("100% #2.mp4"));
    const QStringList files = LocalMedia::filesFromArguments(
      {QStringLiteral("100% #2.mp4"), QUrl::fromLocalFile(first).toString(), dir.filePath("missing.mkv"),
       dir.filePath("folder"), QString(), QStringLiteral("https://example.org/video.mkv"), second},
      root.path());
    // Relative paths resolve against the launch directory; duplicates, folders,
    // missing files and remote URLs are dropped.
    QCOMPARE(files, QStringList({second, first}));
  }

  void sortsByFolderThenNaturalName()
  {
    const QStringList files = LocalMedia::sorted({QStringLiteral("D:/b/第10集.mkv"), QStringLiteral("D:/a/z.mkv"),
                                                  QStringLiteral("D:/b/第2集.mkv"), QStringLiteral("D:/b/第1集.mkv")});
    QCOMPARE(files, QStringList({QStringLiteral("D:/a/z.mkv"), QStringLiteral("D:/b/第1集.mkv"),
                                 QStringLiteral("D:/b/第2集.mkv"), QStringLiteral("D:/b/第10集.mkv")}));
  }

  void folderListsTheOtherEpisodes()
  {
    QTemporaryDir root;
    QDir dir(root.path());
    dir.mkdir("ep 5.mkv");
    const QString first = touch(dir, QStringLiteral("ep 1.mkv"));
    const QString second = touch(dir, QStringLiteral("ep 2.mp4"));
    const QString tenth = touch(dir, QStringLiteral("ep 10.MKV"));
    const QString opened = touch(dir, QStringLiteral("ep 3.xyz"));
    touch(dir, QStringLiteral("ep 4.txt"));
    // Folders and other files stay out; the opened file stays in whatever it is.
    QCOMPARE(LocalMedia::folderVideos(opened), QStringList({first, second, opened, tenth}));
    QCOMPARE(LocalMedia::folderVideos(second), QStringList({first, second, tenth}));
  }

  void playlistEncodesEveryCharacter()
  {
    QTemporaryDir root;
    const QString path = touch(QDir(root.path()), QStringLiteral("100% #2 [x].mp4"));
    const QVariantList entries = LocalMedia::playlist({path});
    QCOMPARE(entries.size(), 1);
    const QVariantMap entry = entries.first().toMap();
    const QString url = entry.value("url").toString();
    // '#' and '%' would otherwise cut or corrupt the path that mpv opens.
    QVERIFY(url.startsWith("file:///"));
    QVERIFY(url.contains("100%25%20%232"));
    QCOMPARE(QUrl(url).toLocalFile(), QDir::fromNativeSeparators(path));
    QCOMPARE(entry.value("title").toString(), QStringLiteral("100% #2 [x]"));
    QCOMPARE(entry.value("fileName").toString(), QStringLiteral("100% #2 [x].mp4"));
  }

  void dialogOffersVideosFirst()
  {
    const QStringList filters = LocalMedia::dialogFilters();
    QCOMPARE(filters.size(), 2);
    QVERIFY(filters.first().startsWith(QStringLiteral("视频文件 (*.mkv *.mp4 ")));
    QCOMPARE(filters.last(), QStringLiteral("所有文件 (*)"));
    QCOMPARE(LocalMedia::videoExtensions().size(), 24);
  }
};

QTEST_APPLESS_MAIN(TestLocalMedia)
#include "test_local_media.moc"
