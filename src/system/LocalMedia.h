#pragma once

#include <QString>
#include <QStringList>
#include <QVariantList>

// Video files on this computer, opened from the command line, a second launch
// ("Open with" in Explorer) or the file dialog. They play without a media
// server: nothing here contacts one.
namespace LocalMedia
{
// Extensions the file dialog offers and the installer registers for "Open with".
const QStringList& videoExtensions();
// The file dialog's name filters: videos first, then every file.
QStringList dialogFilters();
// The existing regular files among command-line arguments, which are paths or
// file:// URLs. Relative paths resolve against workingDirectory. Absolute,
// native separators, in the given order, without duplicates.
QStringList filesFromArguments(const QStringList& arguments, const QString& workingDirectory);
// A batch in file-name order, numbers compared by value ("第2集" before "第10集").
QStringList sorted(QStringList files);
// What the page plays: {url, title, fileName} for each file.
QVariantList playlist(const QStringList& files);
}
