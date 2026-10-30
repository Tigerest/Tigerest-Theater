#include "MpvConfigManager.h"

#include "core/ProfileManager.h"
#include "player/PlayerComponent.h"
#include "settings/SettingsComponent.h"
#include "settings/SettingsSection.h"

#include <QDir>
#include <QDirIterator>
#include <QFile>
#include <QFileInfo>
#include <QLocale>
#include <QLocalSocket>
#include <QSaveFile>
#include <QStandardPaths>
#include <QTextStream>
#include <QDebug>
#include <QUrl>
#include <QVersionNumber>
#include <QRegularExpression>
#include <QCoreApplication>
#include <QCryptographicHash>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <algorithm>

namespace
{
QString g_activeConfigDir;
bool g_ownsDefaultSvpIpc = false;
bool g_rulesLoaded = false;
MpvConf::Rules g_rules;
QString g_backupPath;
QVariantList g_missingShaders;
QVariantList g_notices;

const QString UserConfName = QStringLiteral("mpv.conf");
const QString FallbackConfName = QStringLiteral("mpv.fallback.conf");
const QString OptionCacheName = QStringLiteral("mpv-options-cache.json");
const QString GuideName = QStringLiteral("mpv-ai-guide.md");
const QString BackupName = QStringLiteral("旧版自定义配置备份.txt");
const QString HashLabel = QStringLiteral("# 默认配置校验值：");
const QString VersionLabel = QStringLiteral("# 配置版本：");

#if defined(Q_OS_WIN) || defined(Q_OS_MAC)
// A system font with complete simplified Chinese. A font without CJK (Segoe
// UI, or whatever "sans-serif" resolves to) makes libass ask the system once
// per missing glyph. On Windows DirectWrite answers Yu Gothic UI Semibold for
// kanji it covers but Microsoft JhengHei for simplified-only characters such
// as 难, so one line ends up in two weights; CoreText falls back the same
// per-glyph way. Microsoft YaHei's Latin glyphs are Segoe UI's, and PingFang
// SC has a semibold face for bold subtitles.
#ifdef Q_OS_WIN
const QString CjkFont = QStringLiteral("Microsoft YaHei");
#else
const QString CjkFont = QStringLiteral("PingFang SC");
#endif
#endif

bool copyResourceTree(const QString& sourceRoot, const QString& targetRoot)
{
  QDirIterator it(sourceRoot, QDir::Files, QDirIterator::Subdirectories);
  bool ok = true;
  while (it.hasNext())
  {
    const QString sourcePath = it.next();
    QString relativePath = sourcePath.mid(sourceRoot.length());
    while (relativePath.startsWith('/'))
      relativePath.remove(0, 1);

    const QString targetPath = QDir(targetRoot).filePath(relativePath);
    if (!QDir().mkpath(QFileInfo(targetPath).absolutePath()))
    {
      qWarning() << "Unable to create MPV bundle directory for" << targetPath;
      ok = false;
      continue;
    }

    QFile source(sourcePath);
    if (!source.open(QIODevice::ReadOnly))
    {
      qWarning() << "Unable to read bundled MPV resource" << sourcePath;
      ok = false;
      continue;
    }

    const QByteArray data = source.readAll();
    QFile existing(targetPath);
    if (existing.open(QIODevice::ReadOnly) && existing.readAll() == data)
      continue;

    QSaveFile target(targetPath);
    const bool saved = target.open(QIODevice::WriteOnly) &&
                        target.write(data) == data.size() &&
                        target.commit();
    if (!saved)
    {
      // Windows can reject QSaveFile's atomic rename when antivirus or a
      // previously loaded Lua script briefly holds the managed destination.
      // These files are generated from immutable Qt resources, so a direct
      // truncate/write fallback is safe and lets upgrades repair themselves.
      QFile fallback(targetPath);
      const bool fallbackSaved = fallback.open(QIODevice::WriteOnly | QIODevice::Truncate) &&
                                 fallback.write(data) == data.size();
      fallback.close();
      if (!fallbackSaved)
      {
        qWarning() << "Unable to deploy bundled MPV resource" << targetPath
                   << fallback.errorString();
        ok = false;
      }
    }
  }
  return ok;
}

QByteArray readBytes(const QString& path)
{
  QFile file(path);
  return file.open(QIODevice::ReadOnly) ? file.readAll() : QByteArray();
}

bool writeText(const QString& path, const QString& text)
{
  QSaveFile output(path);
  const QByteArray data = text.toUtf8();
  if (output.open(QIODevice::WriteOnly) && output.write(data) == data.size() && output.commit())
    return true;
  qWarning() << "Unable to write" << path << output.errorString();
  return false;
}

QString headValue(const QString& head, const QString& label)
{
  for (const QString& line : head.split('\n'))
    if (line.startsWith(label))
      return line.mid(label.size()).trimmed();
  return QString();
}

QString renderHead(const QString& defaultHash)
{
  QStringList lines;
  lines << MpvConf::HeadBegin;
  lines << QStringLiteral("# 这是大河影院实际使用的唯一一份 mpv 配置，请在客户端「设置 → MPV 画质与插件」的编辑器里修改。");
  lines << QStringLiteral("# 头部和尾部两块管理区由软件在每次启动及相关设置变化时重写，手动修改会被覆盖；两块之间是用户区。");
  lines << QStringLiteral("# 让 AI 修改前，请先把这份说明交给它：%1").arg(MpvConfigManager::aiGuidePath());
  lines << VersionLabel + QCoreApplication::applicationVersion();
  lines << HashLabel + defaultHash;
  lines << MpvConf::HeadEnd;
  return lines.join('\n') + '\n';
}

void appendOption(QStringList& lines, const QString& comment, const QString& key, const QVariant& value)
{
  lines << QStringLiteral("# ") + comment;
  lines << MpvConf::formatOption(key, MpvConfigManager::optionText(value));
}

QString ipcEndpoint(bool rife)
{
#ifdef Q_OS_WIN
  // Suppress managed SVP discovery when RIFE owns interpolation.
  return rife ? QString() : QStringLiteral("mpvpipe");
#elif defined(Q_OS_MAC)
  // SVP's standard macOS endpoint. Never unlink another running player's socket.
  const QString endpoint = QStringLiteral("/tmp/mpvsocket");
  QLocalSocket existing;
  existing.connectToServer(endpoint);
  const bool occupied = existing.waitForConnected(100);
  const bool ordinaryFile = QFileInfo(endpoint).isFile() || QFileInfo(endpoint).isDir();
  if (occupied || ordinaryFile)
    qWarning() << "SVP IPC endpoint already in use; leaving it untouched:" << endpoint;
  return occupied || ordinaryFile || rife ? QString() : endpoint;
#else
  // "mpvpipe" is a Windows named-pipe convention; Unix would create a
  // relative filesystem socket, so leave it disabled.
  Q_UNUSED(rife)
  return QString();
#endif
}

QString renderTail(const QString& user, const QString& endpoint)
{
  auto& settings = SettingsComponent::Get();
  QStringList lines;
  lines << MpvConf::TailBegin;
  lines << QStringLiteral("# 下面的配置由软件或其他设置页决定，写在用户区之后，保证最终以这里为准；修改请到对应的设置页。");
  lines << QStringLiteral("# 回到全局段，保证下面的配置不落入上面的某个档位。");
  lines << QStringLiteral("[default]");
  const QString profile = MpvConfigManager::startupProfile(user);
  if (profile.isEmpty())
    lines << QStringLiteral("# 用户区里没有可用的画质档位，启动时不应用档位。");
  else
    appendOption(lines, QStringLiteral("启动时使用「MPV 画质与插件 → 画质预设」选中的档位。"), QStringLiteral("profile"), profile);
  appendOption(lines, QStringLiteral("关闭 mpv 原生 OSC，避免与 uosc 同时显示两套播放器控件。"), QStringLiteral("osc"), false);
  appendOption(lines, QStringLiteral("启用 mpv 默认快捷键；同名按键由下一行的大河 input.conf 覆盖。"),
               QStringLiteral("input-default-bindings"), true);
  appendOption(lines, QStringLiteral("从配置目录读取大河内置快捷键。"), QStringLiteral("input-conf"), QStringLiteral("~~/input.conf"));
  appendOption(lines, QStringLiteral("不自动扫描 scripts 目录，脚本只由下面的 script= 显式加载，避免重复加载 uosc 与弹幕脚本。"),
               QStringLiteral("load-scripts"), false);
  appendOption(lines, QStringLiteral("使用内置中文 stats，避免与 mpv 原版同时加载；Ctrl+J 显示概览，Ctrl+Shift+J 查看处理步骤。"),
               QStringLiteral("load-stats-overlay"), false);
  appendOption(lines, QStringLiteral("加载内置中文统计脚本。"), QStringLiteral("script"), QStringLiteral("~~/plugins/stats.lua"));
  if (settings.value(SETTINGS_SECTION_MPV, "enableUosc").toBool())
  {
    appendOption(lines, QStringLiteral("加载 uosc，接管播放时的控制栏、菜单、音轨与全屏界面（MPV 画质与插件 → 使用 uosc）。"),
                 QStringLiteral("script"), QStringLiteral("~~/plugins/uosc.lua"));
    appendOption(lines, QStringLiteral("把 uosc 的码率选择交回 Emby，保留进度、音轨、字幕与播放会话。"),
                 QStringLiteral("script"), QStringLiteral("~~/plugins/emby_quality.lua"));
    appendOption(lines, QStringLiteral("加载画质档位菜单（uosc「滤镜」按钮），切档由软件按用户区中的档位执行。"),
                 QStringLiteral("script"), QStringLiteral("~~/plugins/profile_menu.lua"));
  }
  if (settings.value(SETTINGS_SECTION_MPV, "enableDanmaku").toBool())
    appendOption(lines, QStringLiteral("加载弹幕搜索、匹配、显示和开关状态记忆插件（MPV 画质与插件 → 启用弹幕）。"),
                 QStringLiteral("script"), QStringLiteral("~~/plugins/uosc_danmaku.lua"));
  appendOption(lines, QStringLiteral("文件播放结束后卸载当前媒体，不把最后一帧停在播放器窗口中。"), QStringLiteral("keep-open"), false);
  appendOption(lines, QStringLiteral("没有媒体时保持 mpv 核心存活，Emby 下一次播放复用同一个播放器实例。"), QStringLiteral("idle"), true);
  appendOption(lines, QStringLiteral("播放器窗口由客户端管理，mpv 不自行创建窗口。"), QStringLiteral("force-window"), false);
  appendOption(lines, QStringLiteral("进度由 Emby 保存；禁止 mpv 另存可能带鉴权参数的播放地址。"),
               QStringLiteral("save-position-on-quit"), false);
  appendOption(lines, QStringLiteral("换集时恢复暂停、倍速、平移和缩放，避免上一集的临时操作带到下一集。"),
               QStringLiteral("reset-on-next-file"), QStringLiteral("pause,speed,video-pan-x,video-pan-y,video-zoom"));
  if (endpoint.isEmpty())
    lines << QStringLiteral("# SVP 连接接口未开放：RIFE 开启中、接口已被其他程序占用，或当前平台不使用它。");
  else
    appendOption(lines, QStringLiteral("为 SVP 打开本机连接接口（开启 RIFE 时自动关闭）。"), QStringLiteral("input-ipc-server"), endpoint);

  lines << QString();
  lines << QStringLiteral("# ---- 「视频」设置页 ----");
  for (const auto& option : MpvConfigManager::videoOptions())
    appendOption(lines, option.comment, option.key, option.value);
  lines << QStringLiteral("# display-fps-override 由软件在播放时按当前显示器刷新率设置。");
  if (settings.value(SETTINGS_SECTION_VIDEO, "aspect").toString() != QStringLiteral("custom"))
    lines << QStringLiteral("# video-unscaled、video-aspect-override、keepaspect、panscan 由「画面比例」在播放时设置；选「自定义」后可写在用户区。");
  lines << QString();
  lines << QStringLiteral("# ---- 「字幕」设置页 ----");
  for (const auto& option : MpvConfigManager::subtitleOptions())
    appendOption(lines, option.comment, option.key, option.value);
  lines << QString();
  lines << QStringLiteral("# ---- 「音频」设置页 ----");
  for (const auto& option : MpvConfigManager::audioOptions())
    appendOption(lines, option.comment, option.key, option.value);
  lines << QStringLiteral("# audio-device 由「输出设备」在播放时选择；AC3 转码开启时追加音频滤镜 @ac3。");

  lines << QString();
  lines << QStringLiteral("# ---- 播放时由软件执行的动作（不是配置项，写在这里方便查看完整链路）----");
  lines << QStringLiteral("# · 切换画质档：先清空 glsl-shaders，再按用户区里该档位（含 profile= 继承）的内容逐项设置。");
  lines << QStringLiteral("# · RIFE：播放时追加视频滤镜 @tigerest-rife，停止时移除；它总在用户区的 @user- 滤镜之后，并把 hwdec 临时改为 auto-copy。");
  lines << QStringLiteral("# · RIFE 开启时，用户区里改变帧率或插帧的配置会被改为「#[暂停执行:RIFE]」注释，关闭后自动恢复。");
  lines << QStringLiteral("# · 弹幕：需要时把 video-sync 临时改为 display-vdrop，关闭弹幕后恢复。");
  lines << QStringLiteral("# · 音量、静音、音频与字幕延迟由播放界面实时调整。");
  lines << QStringLiteral("# · 弹幕外观写在 script-opts/uosc_danmaku.conf，由「弹幕样式」设置页管理；uosc 界面写在 script-opts/uosc.conf，不开放修改。");

  const QString testOptions = qEnvironmentVariable("TIGEREST_MPV_TEST_OPTIONS");
  if (!testOptions.isEmpty())
  {
    lines << QString();
    lines << QStringLiteral("# ---- 自动化测试注入（只在设置了 TIGEREST_MPV_TEST_OPTIONS 时出现）----");
    for (const QString& line : MpvConf::normalizeNewlines(testOptions).split('\n', Qt::SkipEmptyParts))
      lines << line.trimmed();
  }
  lines << MpvConf::TailEnd;
  return lines.join('\n') + '\n';
}

QString defaultUserText()
{
  return MpvConf::normalizeNewlines(QString::fromUtf8(readBytes(QStringLiteral(":/mpv/mpv.default.conf"))));
}

void loadRules()
{
  const QJsonObject catalog = QJsonDocument::fromJson(readBytes(QStringLiteral(":/mpvconf/options.json"))).object();
  QJsonObject table;
  if (!g_activeConfigDir.isEmpty())
    table = QJsonDocument::fromJson(readBytes(QDir(g_activeConfigDir).filePath(OptionCacheName))).object();
  const QJsonObject bundled = QJsonDocument::fromJson(readBytes(QStringLiteral(":/mpvconf/mpv-options.json"))).object();
  if (table.value(QStringLiteral("options")).toObject().isEmpty())
    table = bundled;
  else
  {
    // Older mpv (e.g. distribution builds) lists only its native video filters
    // in option-info, yet still bridges every libavfilter filter by name. Keep
    // the bundled names valid so such a build does not reject hflip or fps.
    QJsonObject options = table.value(QStringLiteral("options")).toObject();
    QJsonObject vf = options.value(QStringLiteral("vf")).toObject();
    QJsonArray choices = vf.value(QStringLiteral("choices")).toArray();
    if (!choices.isEmpty())
    {
      for (const QJsonValue& name : bundled.value(QStringLiteral("options")).toObject()
                                        .value(QStringLiteral("vf")).toObject().value(QStringLiteral("choices")).toArray())
        if (!choices.contains(name))
          choices.append(name);
      vf.insert(QStringLiteral("choices"), choices);
      options.insert(QStringLiteral("vf"), vf);
      table.insert(QStringLiteral("options"), options);
    }
  }
  g_rules = MpvConf::Rules::fromJson(catalog, table);
  g_rulesLoaded = true;
}

// Removes bundled shaders that a newer bundle dropped, if the user left them
// unchanged. Earlier bundles shipped without a manifest; their retired files
// are listed in the new manifest with the hashes they had.
void pruneRetiredShaders(const QString& bundleDir, const QJsonObject& previousManifest)
{
  const QString shaderRoot = QDir(bundleDir).filePath(QStringLiteral("shaders"));
  const QJsonObject current = QJsonDocument::fromJson(readBytes(QStringLiteral(":/mpv/shaders/manifest.json"))).object();
  const QJsonObject currentFiles = current.value(QStringLiteral("files")).toObject();
  QJsonObject candidates = previousManifest.value(QStringLiteral("files")).toObject();
  const QJsonObject retired = current.value(QStringLiteral("retired")).toObject();
  for (auto it = retired.begin(); it != retired.end(); ++it)
    candidates.insert(it.key(), it.value());
  const auto sha256 = [](const QByteArray& data) {
    return QString::fromLatin1(QCryptographicHash::hash(data, QCryptographicHash::Sha256).toHex());
  };
  for (auto it = candidates.begin(); it != candidates.end(); ++it)
  {
    const QString relative = it.key();
    if (currentFiles.contains(relative) || relative.startsWith(QStringLiteral("user/")) || relative.contains(QStringLiteral("..")))
      continue;
    const QString path = QDir(shaderRoot).filePath(relative);
    const QByteArray data = readBytes(path);
    if (data.isEmpty())
      continue;
    // The manifest records LF bytes; Windows builds checked out with CRLF
    // line endings shipped the same shaders with CRLF.
    QByteArray lf = data;
    lf.replace("\r\n", "\n");
    const QString expected = it.value().toString();
    if ((sha256(data) == expected || sha256(lf) == expected) && QFile::remove(path))
      qInfo() << "Removed retired bundled shader" << relative;
  }
}

void ensureUserShaderDir()
{
  const QString dir = MpvConfigManager::userShaderDir();
  QDir().mkpath(dir);
  const QString readme = QDir(dir).filePath(QStringLiteral("说明.txt"));
  if (!QFile::exists(readme))
    writeText(readme, QStringLiteral(
        "把自己的 .glsl 着色器放在这个目录里，在 mpv.conf 中写成 glsl-shader=~~/shaders/user/文件名.glsl。\n"
        "客户端升级时只更新内置着色器，不会改动或删除这个目录里的文件。\n"
        "想修改某个内置着色器，请先把它复制到这里再改，直接改内置文件会在升级时被覆盖。\n"));
}

void backupLegacyCustomization(const QString& bundleDir)
{
  auto& settings = SettingsComponent::Get();
  QStringList sections;
  const QString overridesPath = QDir(bundleDir).filePath(QStringLiteral("user-overrides.conf"));
  QStringList overrideLines;
  for (const QString& line : QString::fromUtf8(readBytes(overridesPath)).split('\n'))
    if (!line.trimmed().isEmpty() && !line.trimmed().startsWith('#'))
      overrideLines << line;
  if (!overrideLines.isEmpty())
    sections << QStringLiteral("## user-overrides.conf\n") + overrideLines.join('\n');
  const QString other = settings.value(SETTINGS_SECTION_OTHER, "other_conf").toString().trimmed();
  if (!other.isEmpty())
    sections << QStringLiteral("## 设置页「高级 → 直接传入 mpv.conf 选项」\n") + other;
  if (settings.value(SETTINGS_SECTION_MPV, "advancedProfileOverrides").toBool())
  {
    static const QList<QPair<const char*, const char*>> overrides = {
      {"scale", "scale"}, {"cscale", "cscale"}, {"dscale", "dscale"}, {"interpolation", "interpolation"},
      {"tscale", "tscale"}, {"deband", "deband"}, {"debandIterations", "deband-iterations"},
      {"debandThreshold", "deband-threshold"}, {"debandRange", "deband-range"}, {"debandGrain", "deband-grain"},
      {"sigmoidUpscaling", "sigmoid-upscaling"}, {"correctDownscaling", "correct-downscaling"},
      {"scaleAntiring", "scale-antiring"}, {"cscaleAntiring", "cscale-antiring"},
      {"targetColorspaceHint", "target-colorspace-hint"}, {"iccProfileAuto", "icc-profile-auto"},
      {"toneMapping", "tone-mapping"}, {"gamutMappingMode", "gamut-mapping-mode"},
      {"hdrComputePeak", "hdr-compute-peak"}, {"ditherDepth", "dither-depth"}, {"blendSubtitles", "blend-subtitles"}};
    QStringList values;
    for (const auto& entry : overrides)
      values << MpvConf::formatOption(QString::fromLatin1(entry.second),
                                      MpvConfigManager::optionText(settings.value(SETTINGS_SECTION_MPV, entry.first)));
    sections << QStringLiteral("## 「用下方高级参数覆盖当前档位」开启时的参数\n") + values.join('\n');
  }
  const QString mode = settings.value(SETTINGS_SECTION_MPV, "configMode").toString();
  if (mode == QStringLiteral("system") || mode == QStringLiteral("auto"))
    sections << QStringLiteral("## 旧的 MPV 配置模式\n%1（系统配置目录：%2）。2.9.4 起客户端只读取自己目录中的 mpv.conf，不再读取系统配置。")
                    .arg(mode, settings.value(SETTINGS_SECTION_MPV, "systemConfigDir").toString());
  if (!sections.isEmpty())
  {
    g_backupPath = QDir(bundleDir).filePath(BackupName);
    writeText(g_backupPath, QStringLiteral("# 大河影院 2.9.4 之前的自定义 mpv 配置备份\n"
                                           "# 2.9.4 起 mpv 配置改为在设置页编辑一份完整的 mpv.conf，下面的内容不再生效；需要时请在编辑器中重新设置。\n\n") +
                                sections.join(QStringLiteral("\n\n")) + '\n');
  }
  QFile::remove(overridesPath);
  settings.setValue(SETTINGS_SECTION_OTHER, "other_conf", QString());
}

MpvConfigManager::WriteResult writeConfig(QString user, const QString& defaultHash)
{
  MpvConfigManager::WriteResult result;
  const QVariantMap context = MpvConfigManager::settingsContext();
  const MpvConf::LockResult locks = MpvConf::neutralizeLocked(user, MpvConfigManager::rules(), context);
  result.ignored = locks.ignored;
  const MpvConf::SuspensionResult suspension = MpvConf::applySuspension(locks.user, MpvConfigManager::rules(), context);
  result.suspended = suspension.suspended;
  result.restored = suspension.restored;
  result.user = suspension.user;
  const QString head = renderHead(defaultHash);
  const QString endpoint = ipcEndpoint(SettingsComponent::Get().value(SETTINGS_SECTION_VIDEO, "aiRife").toBool());
  const QString tail = renderTail(result.user, endpoint);
  const QString text = MpvConf::compose(head, result.user, tail);
  // A complete default configuration for the controller's fallback when
  // mpv cannot initialize with the user's file.
  const QString fallback = MpvConf::compose(head, defaultUserText(), renderTail(defaultUserText(), endpoint));
  const QString fallbackPath = QDir(g_activeConfigDir).filePath(FallbackConfName);
  if (QString::fromUtf8(readBytes(fallbackPath)) != fallback)
    writeText(fallbackPath, fallback);
  const QString path = MpvConfigManager::userConfigPath();
  result.ok = QString::fromUtf8(readBytes(path)) == text || writeText(path, text);

  g_missingShaders.clear();
  for (const auto& reference : MpvConf::shaderReferences(MpvConf::parse(result.user), g_activeConfigDir))
    if (!QFileInfo(reference.resolved).isFile())
      g_missingShaders << QVariantMap{{QStringLiteral("line"), reference.line}, {QStringLiteral("path"), reference.written}};
  writeText(MpvConfigManager::aiGuidePath(), MpvConfigManager::aiGuide());
  return result;
}
}

bool MpvConfigManager::ownsDefaultSvpIpc()
{
  return g_ownsDefaultSvpIpc;
}

QString MpvConfigManager::danmakuApiServer(const QString& serverUrl, const QString& connectionMode)
{
  const QUrl server(serverUrl);
  const bool dedicatedLan = connectionMode != "custom" &&
    server.host() == "192.168.5.150" && server.port() == 8095 &&
    (server.scheme() == "http" || server.scheme() == "https");
  // The LAN entry stays on plain HTTP; the public one is HTTPS.
  return dedicatedLan ? QStringLiteral("http://192.168.5.150:18443")
                      : QStringLiteral("https://nas.tigerest.top:18446");
}

QString MpvConfigManager::danmakuStyleConfigText(const QVariantMap& values)
{
  const auto number = [&values](const QString& key, double fallback) {
    bool ok = false;
    const double value = values.value(key, fallback).toDouble(&ok);
    return QLocale::c().toString(ok ? value : fallback, 'g', 12);
  };

  QStringList lines;
  lines << QStringLiteral("bold=%1").arg(values.value(QStringLiteral("bold"), true).toBool()
                                              ? QStringLiteral("yes")
                                              : QStringLiteral("no"));
  lines << QStringLiteral("fontsize=%1").arg(number(QStringLiteral("fontsize"), 50));
  lines << QStringLiteral("outline=%1").arg(number(QStringLiteral("outline"), 1.0));
  lines << QStringLiteral("shadow=%1").arg(number(QStringLiteral("shadow"), 0));
  lines << QStringLiteral("scrolltime=%1").arg(number(QStringLiteral("scrolltime"), 15));
  lines << QStringLiteral("opacity=%1").arg(number(QStringLiteral("opacity"), 0.7));
  lines << QStringLiteral("displayarea=%1").arg(number(QStringLiteral("displayarea"), 0.2));
#if defined(Q_OS_WIN) || defined(Q_OS_MAC)
  // The plugin's own default is sans-serif; see CjkFont.
  lines << QStringLiteral("fontname=%1").arg(CjkFont);
#endif
  return lines.join('\n') + '\n';
}

bool MpvConfigManager::writeDanmakuStyleConfig(const QString& configDir,
                                                const QVariantMap& values,
                                                QString* errorMessage)
{
  const QString scriptOptsDir = QDir(configDir).filePath(QStringLiteral("script-opts"));
  if (!QDir().mkpath(scriptOptsDir))
  {
    if (errorMessage)
      *errorMessage = QStringLiteral("Unable to create %1").arg(scriptOptsDir);
    return false;
  }

  const QString path = QDir(scriptOptsDir).filePath(QStringLiteral("uosc_danmaku.conf"));
  QSaveFile output(path);
  const QByteArray data = danmakuStyleConfigText(values).toUtf8();
  if (!output.open(QIODevice::WriteOnly | QIODevice::Text) ||
      output.write(data) != data.size() || !output.commit())
  {
    if (errorMessage)
      *errorMessage = QStringLiteral("Unable to write %1: %2").arg(path, output.errorString());
    return false;
  }
  return true;
}

QString MpvConfigManager::profileName(const QString& preset)
{
  if (preset.startsWith(QStringLiteral("tigerest-user-"))) return preset;
  if (preset == "liveaction") return "tigerest-liveaction";
  if (preset == "aggressive" || preset == "anime4k")
    return "tigerest-aggressive-test";
  // Map every retired preset to the new user-confirmed default. This keeps
  // upgrades from older settings files valid after removing the old profiles.
  return "tigerest-default";
}

QString MpvConfigManager::startupProfile(const QString& user)
{
  // The preset's profile when the user area still defines it, otherwise the
  // bundled default, otherwise none.
  const QString wanted = profileName(SettingsComponent::Get().value(SETTINGS_SECTION_MPV, "shaderPreset").toString());
  QStringList defined;
  for (const MpvConf::ProfileInfo& info : MpvConf::profiles(MpvConf::parse(user)))
    defined << info.name;
  if (defined.contains(wanted))
    return wanted;
  return defined.contains(QStringLiteral("tigerest-default")) ? QStringLiteral("tigerest-default") : QString();
}

QString MpvConfigManager::presetForProfile(const QString& profile)
{
  if (profile == QStringLiteral("tigerest-liveaction")) return QStringLiteral("liveaction");
  if (profile == QStringLiteral("tigerest-aggressive-test")) return QStringLiteral("aggressive");
  if (profile.startsWith(QStringLiteral("tigerest-user-"))) return profile;
  return QStringLiteral("default");
}

QString MpvConfigManager::optionText(const QVariant& value)
{
  if (value.typeId() == QMetaType::Bool)
    return value.toBool() ? QStringLiteral("yes") : QStringLiteral("no");
  if (value.typeId() == QMetaType::Double || value.typeId() == QMetaType::Float)
    return QLocale::c().toString(value.toDouble(), 'g', 12);
  return value.toString();
}

QList<MpvConfigManager::ManagedOption> MpvConfigManager::videoOptions()
{
  auto& settings = SettingsComponent::Get();
  QList<ManagedOption> options;
  options << ManagedOption{QStringLiteral("video-sync"), settings.value(SETTINGS_SECTION_VIDEO, "sync_mode"),
                           QStringLiteral("视频同步方式（视频 → 同步模式）；开启 RIFE 或弹幕时，播放中可能由它们临时接管。")};
  const QString mode = settings.value(SETTINGS_SECTION_VIDEO, "hardwareDecoding").toString();
  QString hwdec = QStringLiteral("no");
  QString imageFormat = QStringLiteral("no");
  if (mode == QStringLiteral("enabled"))
    hwdec = QStringLiteral("auto");
  else if (mode == QStringLiteral("safe"))
    hwdec = QStringLiteral("auto-safe");
  else if (mode == QStringLiteral("osx_compat"))
  {
    hwdec = QStringLiteral("auto");
    imageFormat = QStringLiteral("uyvy422");
  }
  else if (mode == QStringLiteral("copy"))
    hwdec = QStringLiteral("auto-copy");
  options << ManagedOption{QStringLiteral("hwdec"), hwdec,
                           QStringLiteral("硬件解码（视频 → 硬件解码）；开启 RIFE 时播放中会临时改为回读模式 auto-copy。")};
  options << ManagedOption{QStringLiteral("hwdec-image-format"), imageFormat,
                           QStringLiteral("硬件解码输出格式（视频 → 硬件解码的 macOS 兼容模式）。")};
  options << ManagedOption{QStringLiteral("deinterlace"),
                           settings.value(SETTINGS_SECTION_VIDEO, "deinterlace").toBool() ? QStringLiteral("yes") : QStringLiteral("no"),
                           QStringLiteral("去隔行（视频 → 去隔行）。")};
  options << ManagedOption{QStringLiteral("demuxer-max-bytes"),
                           QStringLiteral("%1MiB").arg(settings.value(SETTINGS_SECTION_VIDEO, "cache").toInt()),
                           QStringLiteral("串流缓存上限（视频 → 缓存）。")};
  return options;
}

QList<MpvConfigManager::ManagedOption> MpvConfigManager::subtitleOptions()
{
  auto& settings = SettingsComponent::Get();
  QList<ManagedOption> options;
  const bool scaled = settings.value(SETTINGS_SECTION_SUBTITLES, "ass_scale_border_and_shadow").toBool();
  options << ManagedOption{QStringLiteral("sub-ass-style-overrides"),
                           scaled ? QStringLiteral("ScaledBorderAndShadow=yes") : QStringLiteral("ScaledBorderAndShadow=no"),
                           QStringLiteral("ASS 边框与阴影是否随分辨率缩放（字幕 → ASS 缩放边框与阴影）。")};
  const QString assOverride = settings.value(SETTINGS_SECTION_SUBTITLES, "ass_style_override").toString();
  if (!assOverride.isEmpty())
    options << ManagedOption{QStringLiteral("sub-ass-override"), assOverride,
                             QStringLiteral("是否用客户端样式覆盖 ASS 字幕（字幕 → ASS 样式覆盖）。")};
  const QVariant size = settings.value(SETTINGS_SECTION_SUBTITLES, "size");
  if (size != -1)
    options << ManagedOption{QStringLiteral("sub-scale"), size.toInt() / 32.0, QStringLiteral("字幕大小（字幕 → 大小）。")};
  const QString font = settings.value(SETTINGS_SECTION_SUBTITLES, "font").toString();
  if (!font.isEmpty())
    options << ManagedOption{QStringLiteral("sub-font"), font, QStringLiteral("字幕字体（字幕 → 字体）。")};
  options << ManagedOption{QStringLiteral("sub-bold"),
                           settings.value(SETTINGS_SECTION_SUBTITLES, "bold").toBool() ? QStringLiteral("yes") : QStringLiteral("no"),
                           QStringLiteral("纯文本字幕是否用粗体（字幕 → 字幕粗体）；ASS 字幕保留脚本自带样式。")};
  const QString color = settings.value(SETTINGS_SECTION_SUBTITLES, "color").toString();
  if (!color.isEmpty())
    options << ManagedOption{QStringLiteral("sub-color"), color, QStringLiteral("字幕颜色（字幕 → 颜色）。")};
  const QString borderColor = settings.value(SETTINGS_SECTION_SUBTITLES, "border_color").toString();
  if (!borderColor.isEmpty())
    options << ManagedOption{QStringLiteral("sub-border-color"), borderColor, QStringLiteral("字幕描边颜色（字幕 → 描边颜色）。")};
  const QVariant borderSize = settings.value(SETTINGS_SECTION_SUBTITLES, "border_size");
  if (borderSize != -1)
    options << ManagedOption{QStringLiteral("sub-border-size"), borderSize.toInt(), QStringLiteral("字幕描边粗细（字幕 → 描边粗细）。")};
  QString backgroundColor = settings.value(SETTINGS_SECTION_SUBTITLES, "background_color").toString();
  const QString backgroundTransparency = settings.value(SETTINGS_SECTION_SUBTITLES, "background_transparency").toString();
  if (!backgroundColor.isEmpty() && !backgroundTransparency.isEmpty())
  {
    // Color is #RRGGBB or #AARRGGBB, insert Alpha after # (at position 1)
    backgroundColor.insert(1, backgroundTransparency);
    options << ManagedOption{QStringLiteral("sub-back-color"), backgroundColor,
                             QStringLiteral("字幕背景色与透明度（字幕 → 背景）。")};
  }
  const auto placement = settings.value(SETTINGS_SECTION_SUBTITLES, "placement").toString().split(',');
  if (placement.length() == 2)
  {
    options << ManagedOption{QStringLiteral("sub-align-x"), placement[0], QStringLiteral("字幕水平位置（字幕 → 位置）。")};
    options << ManagedOption{QStringLiteral("sub-pos"), placement[1] == QStringLiteral("bottom") ? 100 : 10,
                             QStringLiteral("字幕垂直位置（字幕 → 位置）。")};
  }
  return options;
}

QList<MpvConfigManager::ManagedOption> MpvConfigManager::audioOptions()
{
  auto& settings = SettingsComponent::Get();
  QList<ManagedOption> options;
  const QString deviceType = settings.value(SETTINGS_SECTION_AUDIO, "devicetype").toString();
  options << ManagedOption{QStringLiteral("audio-exclusive"), settings.value(SETTINGS_SECTION_AUDIO, "exclusive").toBool(),
                           QStringLiteral("独占音频输出（音频 → 独占模式）。")};
  options << ManagedOption{QStringLiteral("audio-normalize-downmix"),
                           settings.value(SETTINGS_SECTION_AUDIO, "normalize").toBool() ? QStringLiteral("yes") : QStringLiteral("no"),
                           QStringLiteral("下混时归一化音量（音频 → 音量均衡）。")};
  options << ManagedOption{QStringLiteral("audio-swresample-o"), QStringLiteral("surround_mix_level=1"),
                           QStringLiteral("下混时保留环绕声道的音量。")};
  QStringList codecs;
  if (deviceType != AUDIO_DEVICE_TYPE_BASIC)
  {
    SettingsSection* audioSection = settings.getSection(SETTINGS_SECTION_AUDIO);
    const QStringList candidates = deviceType == AUDIO_DEVICE_TYPE_SPDIF ? PlayerComponent::AudioCodecsSPDIF()
                                 : deviceType == AUDIO_DEVICE_TYPE_HDMI ? PlayerComponent::AudioCodecsAll()
                                                                         : QStringList();
    for (const QString& key : candidates)
      if (audioSection && audioSection->value("passthrough." + key).toBool())
        codecs << key;
    // dts-hd includes dts, but listing dts before dts-hd may disable dts-hd.
    if (codecs.contains(QStringLiteral("dts-hd")))
      codecs.removeAll(QStringLiteral("dts"));
  }
  options << ManagedOption{QStringLiteral("audio-spdif"), codecs.join(','), QStringLiteral("直通的音频格式（音频 → 直通）。")};
  QVariant layout = settings.value(SETTINGS_SECTION_AUDIO, "channels");
  // always force either stereo or transcoding
  if (deviceType == AUDIO_DEVICE_TYPE_SPDIF)
    layout = QStringLiteral("2.0");
  options << ManagedOption{QStringLiteral("audio-channels"), layout, QStringLiteral("声道布局（音频 → 声道）。")};
  return options;
}

void MpvConfigManager::configureVapourSynth(const QStringList& installationRoots)
{
  // Finder launches do not inherit shell exports. SVP's Homebrew setup
  // installs this optional runtime, but recent mpv loads it via dlopen.
  // Respect explicit overrides and leave ordinary playback independent of it.
  if (qEnvironmentVariableIsSet("VSSCRIPT_PATH"))
    return;

  for (const QString& root : installationRoots)
  {
    QStringList candidates;
    const QDir pythonLib(QDir(root).filePath(QStringLiteral("libexec/lib")));
    QStringList versions = pythonLib.entryList({QStringLiteral("python3.*")}, QDir::Dirs);
    std::sort(versions.begin(), versions.end(), [](const QString& a, const QString& b) {
      return QVersionNumber::fromString(a.mid(6)) > QVersionNumber::fromString(b.mid(6));
    });
    for (const QString& version : versions)
      candidates << pythonLib.filePath(version + QStringLiteral("/site-packages/vapoursynth/libvsscript.dylib"));
    candidates << QDir(root).filePath(QStringLiteral("lib/libvsscript.dylib"))
               << QDir(root).filePath(QStringLiteral("lib/libvapoursynth-script.dylib"));

    for (const QString& candidate : candidates)
    {
      const QFileInfo library(candidate);
      if (!library.isFile())
        continue;
      // VSScript's Python configuration is keyed by the resolved library path.
      const QString path = library.canonicalFilePath();
      qputenv("VSSCRIPT_PATH", path.toUtf8());
      qInfo() << "VapourSynth runtime:" << path;
      return;
    }
  }
}

bool MpvConfigManager::configureBundledVapourSynth(const QString& executableDirectory,
                                                  const QString& registrationDirectory,bool preferBundled)
{
  const QDir binaryDir(executableDirectory);
  QFile manifest(binaryDir.filePath("../Resources/vapoursynth-runtime.json"));
  if(!manifest.open(QIODevice::ReadOnly))return false;
  const auto values=QJsonDocument::fromJson(manifest.readAll()).object();
  const QString contents=QFileInfo(binaryDir.filePath("..")).canonicalFilePath()+"/";
  const auto resolve=[&](const QString& key){
    const QString relative=values.value(key).toString();
    if(relative.isEmpty()||QDir::isAbsolutePath(relative))return QString();
    const QString path=QFileInfo(binaryDir.filePath(relative)).canonicalFilePath();
    return path.startsWith(contents)?path:QString();
  };
  const auto library=resolve("library"),home=resolve("pythonHome"),packages=resolve("pythonPath");
  if(!QFileInfo(library).isFile()||!QDir(home).exists()||!QDir(packages).exists()||
     !QFileInfo(binaryDir.filePath("vapoursynth")).isExecutable()||
     !QFileInfo(binaryDir.filePath("tigerest-python")).isExecutable())return false;
  // Preserve an explicit external runtime for SVP. When built-in RIFE is
  // selected, its native plugin needs the matching runtime shipped in this app.
  if(!preferBundled&&qEnvironmentVariableIsSet("VSSCRIPT_PATH")&&
      QFileInfo(qEnvironmentVariable("VSSCRIPT_PATH")).canonicalFilePath()!=library)return false;
  if(!QDir().mkpath(registrationDirectory))return false;
  qputenv("VSSCRIPT_PATH",library.toUtf8());
  qputenv("PYTHONHOME",home.toUtf8());qputenv("PYTHONPATH",packages.toUtf8());
  qputenv("PYTHONNOUSERSITE","1");qputenv("PYTHONDONTWRITEBYTECODE","1");
  // VSScript 79 keys registration by the resolved library path and can rebuild
  // it after relocation. Keep its writes outside both the app and user config.
  qputenv("XDG_CONFIG_HOME",QFileInfo(registrationDirectory).absoluteFilePath().toUtf8());
  auto search=qEnvironmentVariable("PATH").split(QDir::listSeparator(),Qt::SkipEmptyParts);
  search.removeAll(binaryDir.absolutePath());search.prepend(binaryDir.absolutePath());
  qputenv("PATH",search.join(QDir::listSeparator()).toUtf8());
  return true;
}

void MpvConfigManager::configureBundledVulkan(const QString& executableDirectory)
{
  // Vulkan otherwise enumerates both the bundled ICD and Homebrew's copy.
  // Honor a deliberate override, but keep ordinary installations self-contained.
  if (!qEnvironmentVariableIsEmpty("VK_DRIVER_FILES") ||
      !qEnvironmentVariableIsEmpty("VK_ICD_FILENAMES"))
    return;
  const QFileInfo manifest(QDir(executableDirectory).filePath(
      "../Resources/vulkan/icd.d/MoltenVK_icd.json"));
  if (manifest.isFile())
    qputenv("VK_DRIVER_FILES", manifest.canonicalFilePath().toUtf8());
}

const MpvConf::Rules& MpvConfigManager::rules()
{
  if (!g_rulesLoaded)
    loadRules();
  return g_rules;
}

void MpvConfigManager::storeOptionTable(const QJsonObject& table)
{
  if (g_activeConfigDir.isEmpty() || table.value(QStringLiteral("options")).toObject().isEmpty())
    return;
  const QString path = QDir(g_activeConfigDir).filePath(OptionCacheName);
  const QByteArray data = QJsonDocument(table).toJson(QJsonDocument::Compact);
  if (readBytes(path) != data)
    writeText(path, QString::fromUtf8(data));
  loadRules();
}

QString MpvConfigManager::cachedOptionTableVersion()
{
  if (g_activeConfigDir.isEmpty())
    return QString();
  return QJsonDocument::fromJson(readBytes(QDir(g_activeConfigDir).filePath(OptionCacheName)))
      .object().value(QStringLiteral("mpvVersion")).toString();
}

QVariantMap MpvConfigManager::settingsContext()
{
  auto& settings = SettingsComponent::Get();
  return {
    {QStringLiteral("video.aiRife"), settings.value(SETTINGS_SECTION_VIDEO, "aiRife").toBool()},
    {QStringLiteral("video.hardwareDecoding"), settings.value(SETTINGS_SECTION_VIDEO, "hardwareDecoding").toString()},
    {QStringLiteral("video.aspect"), settings.value(SETTINGS_SECTION_VIDEO, "aspect").toString()},
  };
}

MpvConf::ValidationContext MpvConfigManager::validationContext()
{
  MpvConf::ValidationContext context;
  context.settings = settingsContext();
  context.configDir = g_activeConfigDir;
  return context;
}

QString MpvConfigManager::defaultUser()
{
  return defaultUserText();
}

MpvConf::Parts MpvConfigManager::readConfig()
{
  return MpvConf::split(QString::fromUtf8(readBytes(userConfigPath())));
}

MpvConfigManager::WriteResult MpvConfigManager::refresh()
{
  const MpvConf::Parts parts = readConfig();
  QString hash = headValue(parts.head, HashLabel);
  if (hash.isEmpty())
    hash = MpvConf::sha256(defaultUserText());
  return writeConfig(parts.user, hash);
}

MpvConfigManager::WriteResult MpvConfigManager::saveUser(const QString& user)
{
  QString hash = headValue(readConfig().head, HashLabel);
  if (hash.isEmpty())
    hash = MpvConf::sha256(defaultUserText());
  return writeConfig(MpvConf::normalizeNewlines(user), hash);
}

MpvConfigManager::WriteResult MpvConfigManager::restoreDefault()
{
  const MpvConf::Parts parts = readConfig();
  const QString backup = QDir(g_activeConfigDir).filePath(QStringLiteral("mpv.conf.before-restore"));
  writeText(backup, MpvConf::normalizeNewlines(parts.user));
  const QString user = defaultUserText();
  return writeConfig(user, MpvConf::sha256(user));
}

bool MpvConfigManager::defaultUpdated()
{
  return headValue(readConfig().head, HashLabel) != MpvConf::sha256(defaultUserText());
}

void MpvConfigManager::acknowledgeDefaultUpdate()
{
  writeConfig(readConfig().user, MpvConf::sha256(defaultUserText()));
}

QString MpvConfigManager::backupPath()
{
  if (g_backupPath.isEmpty() && !g_activeConfigDir.isEmpty())
  {
    const QString candidate = QDir(g_activeConfigDir).filePath(BackupName);
    if (QFile::exists(candidate))
      g_backupPath = candidate;
  }
  return g_backupPath;
}

QVariantList MpvConfigManager::missingShaders()
{
  return g_missingShaders;
}

QVariantList MpvConfigManager::notices()
{
  return g_notices;
}

void MpvConfigManager::addNotice(const QString& kind, const QString& title, const QString& message)
{
  for (const QVariant& notice : g_notices)
    if (notice.toMap().value(QStringLiteral("kind")) == kind)
      return;
  g_notices << QVariantMap{{QStringLiteral("kind"), kind}, {QStringLiteral("title"), title},
                           {QStringLiteral("message"), message}};
}

QString MpvConfigManager::activeConfigDir()
{
  return g_activeConfigDir;
}

QString MpvConfigManager::userConfigPath()
{
  return QDir(g_activeConfigDir).filePath(UserConfName);
}

QString MpvConfigManager::shaderDir()
{
  return QDir(g_activeConfigDir).filePath(QStringLiteral("shaders"));
}

QString MpvConfigManager::userShaderDir()
{
  return QDir(shaderDir()).filePath(QStringLiteral("user"));
}

QString MpvConfigManager::aiGuidePath()
{
  return QDir(g_activeConfigDir).filePath(GuideName);
}

bool MpvConfigManager::prepare()
{
#if defined(Q_OS_MAC)
  const bool preferBundledRife=SettingsComponent::Get().value(SETTINGS_SECTION_VIDEO,"aiRife").toBool();
  configureBundledVulkan(QCoreApplication::applicationDirPath());
  if(!configureBundledVapourSynth(QCoreApplication::applicationDirPath(),
      ProfileManager::activeProfile().dataDir("rife-runtime"),preferBundledRife)) {
#if defined(Q_PROCESSOR_ARM_64)
  configureVapourSynth({QStringLiteral("/opt/homebrew/opt/vapoursynth")});
#else
  configureVapourSynth({QStringLiteral("/usr/local/opt/vapoursynth")});
#endif
  }
#endif
  auto& settings = SettingsComponent::Get();
  // The controller applies this selection after parsing mpv.conf.
  qputenv("TIGEREST_MPV_CONSOLE",
          settings.value(SETTINGS_SECTION_MPV, "enableConsole").toBool() ? "yes" : "no");

  // Existing 2.0.x profiles stored the old sans-serif default explicitly,
  // which would otherwise override the requested Segoe UI value at runtime.
  // Migrate only that former default once; preserve any genuinely custom font.
  if (!settings.value(SETTINGS_SECTION_SUBTITLES, "referenceMpvDefaultsMigrated").toBool())
  {
    const QString font = settings.value(SETTINGS_SECTION_SUBTITLES, "font").toString();
    if (font.isEmpty() || font == QStringLiteral("sans-serif"))
      settings.setValue(SETTINGS_SECTION_SUBTITLES, "font", QStringLiteral("Segoe UI"));
    settings.setValue(SETTINGS_SECTION_SUBTITLES, "referenceMpvDefaultsMigrated", true);
  }
#if defined(Q_OS_WIN) || defined(Q_OS_MAC)
  // Segoe UI was the desktop default through 2.9.5 (and no Mac has it); see
  // CjkFont. Move only that former default, once, so picking Segoe UI again
  // later sticks.
  if (!settings.value(SETTINGS_SECTION_SUBTITLES, "cjkFontMigrated").toBool())
  {
    if (settings.value(SETTINGS_SECTION_SUBTITLES, "font").toString() == QStringLiteral("Segoe UI"))
      settings.setValue(SETTINGS_SECTION_SUBTITLES, "font", CjkFont);
    settings.setValue(SETTINGS_SECTION_SUBTITLES, "cjkFontMigrated", true);
  }
#endif

  const QString legacyPreset = settings.value(SETTINGS_SECTION_MPV, "shaderPreset").toString();
  if (legacyPreset != QStringLiteral("default") &&
      legacyPreset != QStringLiteral("liveaction") &&
      legacyPreset != QStringLiteral("aggressive") &&
      !legacyPreset.startsWith(QStringLiteral("tigerest-user-")))
  {
    // Keep the one intentional Anime4K choice when upgrading; every other
    // retired profile now resolves to the user-confirmed Anime AA default.
    const QString migratedPreset = legacyPreset == QStringLiteral("anime4k")
        ? QStringLiteral("aggressive")
        : QStringLiteral("default");
    settings.setValue(SETTINGS_SECTION_MPV, "shaderPreset", migratedPreset);
    qInfo() << "Migrated retired MPV preset to" << migratedPreset;
  }

  const QString bundleDir = ProfileManager::activeProfile().dataDir("mpv");
  g_activeConfigDir = bundleDir;
  const QJsonObject previousManifest =
      QJsonDocument::fromJson(readBytes(QDir(bundleDir).filePath(QStringLiteral("shaders/manifest.json")))).object();
  if (!QDir().mkpath(bundleDir) || !copyResourceTree(":/mpv", bundleDir))
  {
    qCritical() << "Failed to prepare Tigerest MPV resources";
    return false;
  }
  pruneRetiredShaders(bundleDir, previousManifest);
  ensureUserShaderDir();
  // Files of the pre-2.9.4 layout: the generated template copy and the
  // system-mode companion profiles.
  QFile::remove(QDir(bundleDir).filePath(QStringLiteral("mpv.conf.in")));
  QFile::remove(QDir(bundleDir).filePath(QStringLiteral("tigerest-system-profiles.conf")));

  auto* danmakuSection = settings.getSection(SETTINGS_SECTION_DANMAKU);
  QString danmakuConfigError;
  if (!writeDanmakuStyleConfig(bundleDir,
                               danmakuSection ? danmakuSection->allValues() : QVariantMap(),
                               &danmakuConfigError))
  {
    qCritical() << "Failed to prepare persistent danmaku style configuration:"
                << danmakuConfigError;
    return false;
  }

  loadRules();
  const QString defaultUser = defaultUserText();
  const QString defaultHash = MpvConf::sha256(defaultUser);
  QString user = defaultUser;
  QString recordedHash = defaultHash;
  if (!settings.value(SETTINGS_SECTION_MPV, "mpvConfEditorMigrated").toBool())
  {
    // 2.9.4 replaces the three config modes, user-overrides.conf and the
    // advanced options with this one file. Keep the old customization in a
    // readable backup and start from the default configuration.
    backupLegacyCustomization(bundleDir);
    settings.setValue(SETTINGS_SECTION_MPV, "configMode", QStringLiteral("embedded"));
    settings.setValue(SETTINGS_SECTION_MPV, "advancedProfileOverrides", false);
    settings.setValue(SETTINGS_SECTION_MPV, "mpvConfEditorMigrated", true);
    qInfo() << "Migrated MPV configuration to the single editable mpv.conf";
  }
  else if (QFile::exists(userConfigPath()))
  {
    const MpvConf::Parts parts = readConfig();
    user = parts.user;
    recordedHash = headValue(parts.head, HashLabel);
    const bool untouched = !recordedHash.isEmpty() && MpvConf::sha256(user) == recordedHash;
    if (untouched && recordedHash != defaultHash)
    {
      // The user never changed the previous default: take the new one.
      user = defaultUser;
      recordedHash = defaultHash;
      qInfo() << "Updated the unmodified mpv.conf user area to the new default";
    }
    if (recordedHash.isEmpty())
      recordedHash = defaultHash;
  }
  const QString previousVersion = headValue(readConfig().head, VersionLabel);

  const QString testOptions = qEnvironmentVariable("TIGEREST_MPV_TEST_OPTIONS");
  g_ownsDefaultSvpIpc = !testOptions.contains(QRegularExpression(
      QStringLiteral("(^|\\n)\\s*(input-ipc-server|include)\\s*=")));
  const WriteResult written = writeConfig(user, recordedHash);
  if (!written.ok)
  {
    qCritical() << "Failed to write the MPV configuration" << userConfigPath();
    return false;
  }
  if (!written.ignored.isEmpty())
    addNotice(QStringLiteral("ignored"), QStringLiteral("mpv 配置里有不能生效的行"),
              QStringLiteral("mpv.conf 的用户区写了 %1 行由软件管理的配置，已被注释并标为「已忽略」，请到设置页查看。")
                  .arg(written.ignored.size()));
  if (!g_missingShaders.isEmpty() && previousVersion != QCoreApplication::applicationVersion())
    addNotice(QStringLiteral("missing-shaders"), QStringLiteral("有着色器文件找不到了"),
              QStringLiteral("本次更新后，mpv.conf 引用的 %1 个着色器文件不存在，对应档位播放时会缺少这些处理。请到设置页的编辑器里修改标红的行。")
                  .arg(g_missingShaders.size()));

  qInfo() << "Using MPV configuration:" << userConfigPath();
  qputenv("TIGEREST_MPV_CONFIG_DIR", g_activeConfigDir.toUtf8());
  qputenv("TIGEREST_MPV_FALLBACK_CONFIG", QDir(g_activeConfigDir).filePath(FallbackConfName).toUtf8());
  return true;
}

QString MpvConfigManager::aiGuide()
{
  const MpvConf::Rules& rules = MpvConfigManager::rules();
  const QVariantMap settings = settingsContext();
  const QString mpvVersion = rules.mpvOptions.isEmpty() ? QStringLiteral("（未知版本）")
      : QJsonDocument::fromJson(readBytes(QDir(g_activeConfigDir).filePath(OptionCacheName)))
            .object().value(QStringLiteral("mpvVersion")).toString();
  QStringList out;
  out << QStringLiteral("# 大河影院 mpv.conf 修改说明（给 AI 的约束）");
  out << QString();
  out << QStringLiteral("你要修改的是大河影院（Emby / Jellyfin 播放客户端）使用的唯一一份 mpv.conf，播放内核是 libmpv %1。请先读完这份说明再动手；它由客户端按当前版本和设置自动生成。")
             .arg(mpvVersion.isEmpty() ? QStringLiteral("（版本见设置页诊断）") : mpvVersion);
  out << QString();
  out << QStringLiteral("## 交付方式");
  out << QStringLiteral("- 只以文本形式输出修改后的完整 mpv.conf（或只输出用户区），由用户粘贴回客户端「设置 → MPV 画质与插件」的编辑器；编辑器会先展示改动，用户确认后才应用。");
  out << QStringLiteral("- 不要直接修改磁盘上的 mpv.conf，也不要让用户用其他程序改它。客户端每次启动都会重写两块管理区，并把用户区里不允许的行注释掉。");
  out << QStringLiteral("- 不要改动两块管理区：从「%1」到「%2」，以及从「%3」到「%4」。粘贴时客户端会丢弃对管理区的改动。")
             .arg(MpvConf::HeadBegin, MpvConf::HeadEnd, MpvConf::TailBegin, MpvConf::TailEnd);
  out << QString();
  out << QStringLiteral("## 文件结构");
  out << QStringLiteral("1. 头部管理区（只读）：版本和默认配置校验值。");
  out << QStringLiteral("2. 用户区：先是全局选项，然后是档位段 [tigerest-quality-base]（公共基础，不在菜单中显示）、[tigerest-default]、[tigerest-liveaction]、[tigerest-aggressive-test]，以及用户自建的 [tigerest-user-*]。");
  out << QStringLiteral("3. 尾部管理区（只读）：以 [default] 开头，写着由软件和其他设置页决定的配置，以及播放时软件执行的动作说明。它在用户区之后，最终以它为准。");
  out << QString();
  out << QStringLiteral("## 写法规则");
  out << QStringLiteral("- mpv.conf 语法：每行 key=value；以 # 开头的是注释。值里有 # 或首尾空格时用双引号括起来（例如 sub-color=\"#FFFFFF\"），没加引号的 # 会被当成注释把后面截断。");
  out << QStringLiteral("- 每个配置行的上一行写一行中文说明注释，保持现有风格。");
  out << QStringLiteral("- 档位：[名称] 开始一段；profile=其他档位 表示继承；profile-desc= 是菜单里显示的名称。切到某档时，客户端先清空 glsl-shaders，再按顺序执行该档（含继承）的内容；档位里没写的项保持当前值。");
  out << QStringLiteral("- 自建档位名必须以 tigerest-user- 开头并写 profile-desc，它会出现在设置页「画质预设」和 uosc「滤镜」菜单里。");
  out << QStringLiteral("- 不要在全局部分写 profile=：启动档位由设置页的「画质预设」决定，写在尾部管理区。");
  out << QString();
  out << QStringLiteral("## 禁止写在用户区的配置项（由软件管理）");
  QMap<QString, QStringList> lockedByReason;
  for (auto it = rules.locked.begin(); it != rules.locked.end(); ++it)
    lockedByReason[it.value()] << it.key();
  for (auto it = lockedByReason.begin(); it != lockedByReason.end(); ++it)
  {
    QStringList keys = it.value();
    keys.sort();
    out << QStringLiteral("- %1：%2").arg(keys.join(QStringLiteral("、")), it.key());
  }
  out << QString();
  out << QStringLiteral("## 由其他设置页决定的配置项（只读，改值请到对应设置页）");
  for (const MpvConf::PageGroup& group : rules.pages)
  {
    QString line = QStringLiteral("- 「%1」设置页：%2").arg(group.page, group.keys.join(QStringLiteral("、")));
    if (!group.unlessKey.isEmpty())
    {
      const bool unlocked = settings.value(group.unlessSection + '.' + group.unlessKey).toString() == group.unlessValue;
      line += QStringLiteral("（「画面比例」选「自定义」时可以写在用户区；当前%1）").arg(unlocked ? QStringLiteral("可以写") : QStringLiteral("不能写"));
    }
    out << line;
  }
  out << QString();
  out << QStringLiteral("## 按功能开关临时锁定");
  for (const MpvConf::Conditional& conditional : rules.conditionals)
  {
    QStringList what;
    for (const MpvConf::ConditionalRule& rule : conditional.rules)
    {
      if (rule.hasValues)
        what << QStringLiteral("%1=yes").arg(rule.key);
      if (!rule.filters.isEmpty() || !rule.contains.isEmpty())
        what << QStringLiteral("vf 中的 %1 滤镜，以及名称或参数含 %2 的滤镜")
                    .arg(rule.filters.join(QStringLiteral("、")), rule.contains.join(QStringLiteral("、")));
    }
    out << QStringLiteral("- %1（当前%2）：%3。开启时这些行会被改成「%4%5] 原内容」注释，关闭后自动恢复。不要删除或改写这种标记行。")
               .arg(conditional.title,
                    rules.conditionalActive(conditional, settings) ? QStringLiteral("已开启") : QStringLiteral("未开启"),
                    what.join(QStringLiteral("；")), MpvConf::SuspendedPrefix, conditional.id);
  }
  out << QStringLiteral("- 「%1…] 原内容」标记表示这一行写了不允许的配置项，已被软件注释，不会执行。").arg(MpvConf::IgnoredPrefix);
  out << QString();
  out << QStringLiteral("## 着色器（glsl-shader）");
  out << QStringLiteral("- 写在档位段里：先写 glsl-shaders= 清空，再用 glsl-shader= 逐个追加，按书写顺序执行。写在全局部分的着色器会在切档时被清空。");
  out << QStringLiteral("- 内置着色器写 glsl-shader=~~/shaders/<组>/<文件>.glsl；用户自己的放在 shaders/user/ 目录（%1），写 glsl-shader=~~/shaders/user/<文件>.glsl。").arg(userShaderDir());
  out << QStringLiteral("- 作用于同一阶段的着色器不要叠加（例如两个亮度放大）；Anime4K 的常见顺序：高光钳制 → 修复 → 放大 → 预缩小 → 放大 → 线条处理。");
  out << QStringLiteral("- 性能开销是相对档位（低 / 中 / 高 / 极高）；实测毫秒数来自 %1，放大到 1920×1080 时测得，仅供比较量级。放大类只在输出比片源大时运行。")
             .arg(QJsonDocument::fromJson(readBytes(QStringLiteral(":/mpvconf/shaders.json"))).object()
                      .value(QStringLiteral("measuredOn")).toString(QStringLiteral("开发者设备")));
  out << QString();
  out << QStringLiteral("### 内置着色器");
  const QJsonObject shaders = QJsonDocument::fromJson(readBytes(QStringLiteral(":/mpvconf/shaders.json"))).object();
  for (const QJsonValue& value : shaders.value(QStringLiteral("shaders")).toArray())
  {
    const QJsonObject shader = value.toObject();
    QString cost = shader.value(QStringLiteral("cost")).toString();
    if (shader.value(QStringLiteral("measuredMs")).isDouble())
      cost += QStringLiteral("（实测约 %1 ms）").arg(shader.value(QStringLiteral("measuredMs")).toDouble());
    out << QStringLiteral("- ~~/shaders/%1 — %2；%3；适合%4；%5；开销%6，强度%7。%8")
               .arg(shader.value(QStringLiteral("path")).toString(), shader.value(QStringLiteral("title")).toString(),
                    shader.value(QStringLiteral("purpose")).toString(), shader.value(QStringLiteral("content")).toString(),
                    shader.value(QStringLiteral("trigger")).toString(), cost,
                    shader.value(QStringLiteral("strength")).toString(), shader.value(QStringLiteral("note")).toString());
  }
  out << QString();
  out << QStringLiteral("### shaders/user 目录中的着色器");
  QDirIterator userFiles(userShaderDir(), {QStringLiteral("*.glsl"), QStringLiteral("*.hook")}, QDir::Files,
                         QDirIterator::Subdirectories);
  QStringList mine;
  while (userFiles.hasNext())
    mine << QStringLiteral("- ~~/shaders/user/") + QDir(userShaderDir()).relativeFilePath(userFiles.next());
  mine.sort();
  out << (mine.isEmpty() ? QStringList{QStringLiteral("- （目前没有）")} : mine);
  out << QString();
  out << QStringLiteral("## vf 视频滤镜");
  out << QStringLiteral("- 只能写在全局部分（第一个档位之前），写成 vf-append=@user-<编号>:<滤镜名>=<参数>，每个滤镜都要有唯一的 @user- 标签。不要写 vf=、vf-clr，不要碰其他标签。");
  out << QStringLiteral("- 执行顺序：用户区的 @user- 滤镜 → RIFE（@tigerest-rife）或 SVP。");
  out << QStringLiteral("- 大多数 FFmpeg 滤镜在 CPU 上运行，需要「视频 → 硬件解码」选回读（copy）模式；当前设置：%1。")
             .arg(settings.value(QStringLiteral("video.hardwareDecoding")).toString());
  out << QString();
  out << QStringLiteral("## 写完后的自检");
  out << QStringLiteral("- 每行都是合法的 key=value、[档位名] 或注释，配置项名称存在于这个 mpv 版本。");
  out << QStringLiteral("- 没有使用上面禁止或由其他设置页决定的配置项；着色器路径都存在；profile= 引用的档位都存在；vf 标签不重复。");
  out << QStringLiteral("- 用户粘贴回编辑器后，标红的行必须修正；标黄的行是被功能暂停的，属正常。");
  out << QString();
  out << QStringLiteral("## 恢复");
  out << QStringLiteral("- 设置页「恢复默认配置」会把用户区换回默认内容，原来的用户区备份为 mpv.conf.before-restore。");
  return out.join('\n') + '\n';
}
