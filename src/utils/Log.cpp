//
// Created by Tobias Hieta on 07/03/16.
//

#include "Log.h"

#include <QtQml>
#include <QGuiApplication>
#include <QRegularExpression>
#include <QSaveFile>
#include <iostream>

#include "shared/Names.h"
#include "shared/Paths.h"
#include "core/ProfileManager.h"
#include "settings/SettingsComponent.h"
#include "Version.h"

int fileLogLevel = 1;  // info
int terminalLogLevel = 3;  // error
QHash<QtMsgType, int> messageLevelValue({{QtDebugMsg, 0}, {QtInfoMsg, 1}, {QtWarningMsg, 2}, {QtCriticalMsg, 3}, {QtFatalMsg, 4}});

static QMutex logMutex;
static QFile* logFile = nullptr;
static QString tempLogPath;

/////////////////////////////////////////////////////////////////////////////////////////
// adapted from https://stackoverflow.com/a/62390212
static void qtMessageOutput(QtMsgType type, const QMessageLogContext& context, const QString& msg)
{
  QMutexLocker lock(&logMutex);

  // Check if message meets any output threshold
  bool shouldOutputToTerminal = messageLevelValue[type] >= terminalLogLevel;
  bool shouldOutputToFile = messageLevelValue[type] >= fileLogLevel;

  if (!shouldOutputToTerminal && !shouldOutputToFile && type != QtFatalMsg)
    return;

  if (shouldOutputToTerminal) {
    QString terminalMsg;
    if (terminalLogLevel == 0) {  // debug level
      terminalMsg = qFormatLogMessage(type, context, msg);
    } else {
      terminalMsg = msg;
    }
    Log::CensorAuthTokens(terminalMsg);
    std::cerr << qPrintable(terminalMsg) << std::endl;
  }

  if (logFile && logFile->isOpen() && shouldOutputToFile) {
    QString fileMessage = qFormatLogMessage(type, context, msg);
    Log::CensorAuthTokens(fileMessage);
    logFile->write(fileMessage.toUtf8() + '\n');
    logFile->flush();
  }

  if (type == QtFatalMsg)
    abort();
}

/////////////////////////////////////////////////////////////////////////////////////////
static void elidePattern(QString& msg, const QString& substring, qsizetype chars)
{
  qsizetype start = 0;
  while (true)
  {
    start = msg.indexOf(substring, start);
    if (start < 0 || start + substring.length() + chars > msg.length())
      break;
    start += substring.length();
    for (qsizetype n = 0; n < chars; n++)
      msg[start + n] = QChar('x');
  }
}

/////////////////////////////////////////////////////////////////////////////////////////
static void elideCapturedValues(QString& msg, const QRegularExpression& pattern)
{
  auto matches = pattern.globalMatch(msg);
  while (matches.hasNext())
  {
    const QRegularExpressionMatch match = matches.next();
    const qsizetype start = match.capturedStart(1);
    const qsizetype length = match.capturedLength(1);
    for (qsizetype n = 0; start >= 0 && n < length; n++)
      msg[start + n] = QChar('x');
  }
}

/////////////////////////////////////////////////////////////////////////////////////////
void Log::CensorAuthTokens(QString& msg)
{
  elidePattern(msg, "api_key=", 32);
  elidePattern(msg, "X-MediaBrowser-Token%3D", 32);
  elidePattern(msg, "X-MediaBrowser-Token=", 32);
  elidePattern(msg, "X-Emby-Token%3D", 32);
  elidePattern(msg, "X-Emby-Token=", 32);
  elidePattern(msg, "api_key=", 32);
  elidePattern(msg, "ApiKey=", 32);
  elidePattern(msg, "AccessToken=", 32);
  elidePattern(msg, "AccessToken\":\"", 32);
  elidePattern(msg, "Token=\"", 32);
  elidePattern(msg, "Token%3D%22", 32);

  // libmpv logs HTTP headers using a colon instead of the URL/query-string
  // equals sign handled above. Mask the complete captured value without
  // assuming a fixed token length or changing the surrounding log structure.
  elideCapturedValues(msg, QRegularExpression(
    QStringLiteral("(?i)X-(?:Emby|MediaBrowser)-Token\\s*:\\s*([^\\s\\\"\\\\\\],;&]+)")));
  elideCapturedValues(msg, QRegularExpression(
    QStringLiteral("(?i)Authorization\\s*:\\s*Bearer\\s+([^\\s\\\"\\\\\\],;&]+)")));
}


/////////////////////////////////////////////////////////////////////////////////////////
static QString getLogDir()
{
  return ProfileManager::activeProfile().logDir();
}

/////////////////////////////////////////////////////////////////////////////////////////
static void censorExistingLogs(const QString& logDir)
{
  const QString basePath = QDir(logDir).filePath(Names::DataName() + ".log");
  for (int index = 0; index <= 10; index++)
  {
    const QString path = index == 0 ? basePath : basePath + "." + QString::number(index);
    QFile source(path);
    if (!source.open(QIODevice::ReadOnly))
      continue;

    const QByteArray originalBytes = source.readAll();
    source.close();
    QString censored = QString::fromUtf8(originalBytes);
    Log::CensorAuthTokens(censored);
    const QByteArray censoredBytes = censored.toUtf8();
    if (censoredBytes == originalBytes)
      continue;

    QSaveFile destination(path);
    if (!destination.open(QIODevice::WriteOnly | QIODevice::Text))
      continue;
    if (destination.write(censoredBytes) != censoredBytes.size())
    {
      destination.cancelWriting();
      continue;
    }
    destination.commit();
  }
}

/////////////////////////////////////////////////////////////////////////////////////////
void Log::Init()
{
  qSetMessagePattern("%{time yyyy-MM-dd hh:mm:ss.zzz} [%{type}] %{function} @ %{line} - %{message}");
  qInstallMessageHandler(qtMessageOutput);

  // Create unique log file for this instance
  QString logDir = getLogDir();
  // Upgrade old logs in place before rotation. Earlier versions covered URL
  // query tokens but not libmpv's colon-form HTTP header diagnostics.
  censorExistingLogs(logDir);
  QTemporaryFile tempFile(logDir + "/jellyfin-desktop-XXXXXX.log");
  tempFile.setAutoRemove(false);
  if (!tempFile.open())
  {
    qFatal("Failed to create temporary log file");
  }
  tempLogPath = tempFile.fileName();
  tempFile.close();

  logFile = new QFile(tempLogPath);
  logFile->open(QIODevice::WriteOnly | QIODevice::Text | QIODevice::Truncate);

  qInfo() << "Starting Jellyfin version:" << qPrintable(Version::GetVersionString()) << "build date:" << qPrintable(Version::GetBuildDate());
  qInfo() << qPrintable(QString("  Running on: %1 [%2] arch %3").arg(QSysInfo::prettyProductName()).arg(QSysInfo::kernelVersion()).arg(QSysInfo::currentCpuArchitecture()));
  qInfo() << "  Qt Version:" << QT_VERSION_STR << qPrintable(QString("[%1]").arg(QSysInfo::buildAbi()));

  qDebug() << "Logging to " << qPrintable(getLogDir() + "/" + Names::DataName() + ".log");
}

/////////////////////////////////////////////////////////////////////////////////////////
void Log::RotateLog()
{
  QMutexLocker lock(&logMutex);

  // Flush and close current unique log file
  if (logFile && logFile->isOpen())
  {
    logFile->flush();
    logFile->close();
  }

  QString baseName = Names::DataName() + ".log";
  QString mainLog = getLogDir() + "/" + baseName;

  // Rotate existing logs: .log.2 -> .log.3, .log.1 -> .log.2, .log -> .log.1
  const int maxLogs = 10;
  for (int i = maxLogs - 1; i >= 1; i--)
  {
    QString from = mainLog + "." + QString::number(i);
    QString to = mainLog + "." + QString::number(i + 1);
    if (QFile::exists(from))
    {
      QFile::remove(to);
      QFile::rename(from, to);
    }
  }

  // Rotate main log to .log.1
  if (QFile::exists(mainLog))
  {
    QFile::remove(mainLog + ".1");
    QFile::rename(mainLog, mainLog + ".1");
  }

  // Rename unique log to main log
  QFile::rename(tempLogPath, mainLog);

  // Reopen as main log and continue writing
  delete logFile;
  logFile = new QFile(mainLog);
  logFile->open(QIODevice::WriteOnly | QIODevice::Text | QIODevice::Append);
}

/////////////////////////////////////////////////////////////////////////////////////////
void Log::Cleanup()
{
  QMutexLocker lock(&logMutex);

  // Close and delete temp log file
  if (logFile && logFile->isOpen())
    logFile->close();

  delete logFile;
  logFile = nullptr;

  if (!tempLogPath.isEmpty())
  {
    QFile::remove(tempLogPath);
    tempLogPath.clear();
  }
}

/////////////////////////////////////////////////////////////////////////////////////////
void Log::ApplyConfigLogLevel()
{
  // --log-level sets both to the same; being different means --log-level not specified
  if (terminalLogLevel == 3 && fileLogLevel == 1)
  {
    QString level = SettingsComponent::Get().value(SETTINGS_SECTION_MAIN, "logLevel").toString();
    if (level.size())
    {
      int levelValue = ParseLogLevel(level);
      if (levelValue != -1)
      {
        fileLogLevel = levelValue;
      }
    }
  }
}

/////////////////////////////////////////////////////////////////////////////////////////
int Log::ParseLogLevel(const QString& str)
{
  if (str == "debug")     return 0;
  if (str == "info")      return 1;
  if (str == "warn")      return 2;
  if (str == "error")     return 3;
  if (str == "fatal")     return 4;
  return -1;
}

/////////////////////////////////////////////////////////////////////////////////////////
void Log::SetLogLevel(const QString& level)
{
  terminalLogLevel = ParseLogLevel(level);
  fileLogLevel = terminalLogLevel;
}
