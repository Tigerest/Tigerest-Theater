#include "LocalMedia.h"

#include <QCollator>
#include <QDir>
#include <QFileInfo>
#include <QUrl>
#include <QVariantMap>
#include <algorithm>

namespace LocalMedia
{

const QStringList& videoExtensions()
{
  static const QStringList extensions{
    "mkv", "mp4", "m4v", "mov", "avi", "wmv", "asf", "flv", "f4v", "webm", "ts", "m2ts", "mts",
    "tp", "mpg", "mpeg", "m2v", "vob", "rmvb", "rm", "3gp", "3g2", "ogv", "divx"};
  return extensions;
}

QStringList dialogFilters()
{
  QStringList patterns;
  for (const QString& extension : videoExtensions())
    patterns << QStringLiteral("*.") + extension;
  return {QStringLiteral("视频文件 (%1)").arg(patterns.join(' ')), QStringLiteral("所有文件 (*)")};
}

QStringList filesFromArguments(const QStringList& arguments, const QString& workingDirectory)
{
  QStringList files;
  for (const QString& argument : arguments)
  {
    if (argument.isEmpty())
      continue;
    QString path = argument;
    if (argument.startsWith(QStringLiteral("file:"), Qt::CaseInsensitive))
    {
      const QUrl url(argument);
      if (!url.isLocalFile())
        continue;
      path = url.toLocalFile();
    }
    const QFileInfo info(QDir(workingDirectory), path);
    if (!info.isFile())
      continue;
    const QString absolute = QDir::toNativeSeparators(info.absoluteFilePath());
    if (!files.contains(absolute, Qt::CaseInsensitive))
      files << absolute;
  }
  return files;
}

QStringList sorted(QStringList files)
{
  QCollator collator;
  collator.setNumericMode(true);
  collator.setCaseSensitivity(Qt::CaseInsensitive);
  std::stable_sort(files.begin(), files.end(), [&collator](const QString& a, const QString& b) {
    const QFileInfo left(a), right(b);
    const int folder = collator.compare(left.absolutePath(), right.absolutePath());
    return folder != 0 ? folder < 0 : collator.compare(left.fileName(), right.fileName()) < 0;
  });
  return files;
}

QVariantList playlist(const QStringList& files)
{
  QVariantList entries;
  for (const QString& file : files)
  {
    const QFileInfo info(file);
    entries << QVariantMap{{"url", QUrl::fromLocalFile(info.absoluteFilePath()).toString(QUrl::FullyEncoded)},
                           {"title", info.completeBaseName()},
                           {"fileName", info.fileName()}};
  }
  return entries;
}

}
