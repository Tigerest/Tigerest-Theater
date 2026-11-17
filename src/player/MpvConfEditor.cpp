#include "MpvConfEditor.h"

#include "MpvConfDocument.h"
#include "MpvConfigManager.h"

#include <QDir>
#include <QDirIterator>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QSet>

namespace
{
QString kindName(MpvConf::Line::Kind kind)
{
  switch (kind)
  {
  case MpvConf::Line::Blank: return QStringLiteral("blank");
  case MpvConf::Line::Comment: return QStringLiteral("comment");
  case MpvConf::Line::Section: return QStringLiteral("section");
  case MpvConf::Line::Option: return QStringLiteral("option");
  case MpvConf::Line::Suspended: return QStringLiteral("suspended");
  case MpvConf::Line::Ignored: return QStringLiteral("ignored");
  case MpvConf::Line::Invalid: return QStringLiteral("invalid");
  }
  return QString();
}

QVariant readJsonResource(const QString& path)
{
  QFile file(path);
  if (!file.open(QIODevice::ReadOnly))
    return QVariant();
  return QJsonDocument::fromJson(file.readAll()).toVariant();
}

QVariantMap failure(const QString& message)
{
  return {{QStringLiteral("error"), message}};
}

int lastGlobalOption(const QList<MpvConf::Line>& lines)
{
  int last = 0;
  for (const MpvConf::Line& line : lines)
  {
    if (line.kind == MpvConf::Line::Section)
      break;
    if (line.kind == MpvConf::Line::Option || line.kind == MpvConf::Line::Suspended ||
        line.kind == MpvConf::Line::Ignored)
      last = line.number;
  }
  return last;
}

QString sectionAfter(const QList<MpvConf::Line>& lines, int afterLine)
{
  if (afterLine <= 0 || lines.isEmpty())
    return QStringLiteral("default");
  return lines.value(qMin(afterLine, int(lines.size())) - 1).section;
}

QString nextFilterLabel(const QList<MpvConf::Line>& lines)
{
  QSet<QString> used;
  for (const MpvConf::Line& line : lines)
    if (line.kind == MpvConf::Line::Option || line.kind == MpvConf::Line::Suspended)
      for (const MpvConf::FilterEntry& filter : MpvConf::parseFilters(line.value))
        used.insert(filter.label);
  for (int i = 1;; ++i)
  {
    const QString label = QStringLiteral("user-%1").arg(i);
    if (!used.contains(label))
      return label;
  }
}
}

namespace MpvConfEditor
{

QVariantList userShaders()
{
  QVariantList result;
  const QString root = MpvConfigManager::userShaderDir();
  QDirIterator it(root, {QStringLiteral("*.glsl"), QStringLiteral("*.hook")}, QDir::Files, QDirIterator::Subdirectories);
  QStringList paths;
  while (it.hasNext())
    paths << QStringLiteral("user/") + QDir(root).relativeFilePath(it.next());
  paths.sort();
  for (const QString& path : paths)
    result << path;
  return result;
}

QVariantMap analyze(const QString& user, const QString& section)
{
  const MpvConf::Rules& rules = MpvConfigManager::rules();
  const MpvConf::ValidationContext context = MpvConfigManager::validationContext();
  const QList<MpvConf::Line> lines = MpvConf::parse(user);

  QVariantList lineList;
  for (const MpvConf::Line& line : lines)
    lineList << QVariantMap{{QStringLiteral("n"), line.number}, {QStringLiteral("kind"), kindName(line.kind)},
                            {QStringLiteral("section"), line.section}, {QStringLiteral("key"), line.key},
                            {QStringLiteral("value"), line.value}, {QStringLiteral("reasons"), line.reasons}};

  QVariantList diagnostics;
  int errors = 0;
  int warnings = 0;
  for (const MpvConf::Diagnostic& diagnostic : MpvConf::validate(user, rules, context))
  {
    errors += diagnostic.severity == QStringLiteral("error");
    warnings += diagnostic.severity == QStringLiteral("warning");
    diagnostics << QVariantMap{{QStringLiteral("line"), diagnostic.line}, {QStringLiteral("severity"), diagnostic.severity},
                               {QStringLiteral("code"), diagnostic.code}, {QStringLiteral("message"), diagnostic.message}};
  }

  QVariantList profileList;
  for (const MpvConf::ProfileInfo& profile : MpvConf::profiles(lines))
  {
    QString error;
    const int shaders = MpvConf::shaderCount(MpvConf::resolveProfile(lines, profile.name, &error));
    profileList << QVariantMap{{QStringLiteral("name"), profile.name}, {QStringLiteral("description"), profile.description},
                               {QStringLiteral("line"), profile.line}, {QStringLiteral("shaders"), shaders}};
  }

  // Values the form shows: profile-scope options inside `section` (with
  // inheritance), global options from the global part.
  QVariantMap form;
  QVariantMap blocked;
  for (const QJsonValue& value : rules.catalog.value(QStringLiteral("options")).toArray())
  {
    const QJsonObject option = value.toObject();
    const QString key = option.value(QStringLiteral("key")).toString();
    const bool profileScope = option.value(QStringLiteral("scope")).toString() == QStringLiteral("profile");
    const MpvConf::ResolvedValue resolved =
        MpvConf::resolveValue(lines, profileScope ? section : QStringLiteral("default"), key);
    form.insert(key, QVariantMap{{QStringLiteral("found"), resolved.found}, {QStringLiteral("value"), resolved.value},
                                 {QStringLiteral("section"), resolved.section}, {QStringLiteral("line"), resolved.line}});
    const QStringList reasons = rules.suspendReasons(key, QStringLiteral("yes"), context.settings);
    if (!reasons.isEmpty() && key != QStringLiteral("vf-append"))
      blocked.insert(key, QStringLiteral("%1 已开启，暂不可添加").arg(reasons.join(QStringLiteral("、"))));
  }

  return {{QStringLiteral("lines"), lineList},
          {QStringLiteral("diagnostics"), diagnostics},
          {QStringLiteral("errors"), errors},
          {QStringLiteral("warnings"), warnings},
          {QStringLiteral("profiles"), profileList},
          {QStringLiteral("section"), section},
          {QStringLiteral("form"), form},
          {QStringLiteral("blocked"), blocked},
          {QStringLiteral("settings"), context.settings}};
}

QVariantMap state(const QString& activeProfile)
{
  const MpvConf::Parts parts = MpvConfigManager::readConfig();
  QVariantMap result{
    {QStringLiteral("user"), parts.user},
    {QStringLiteral("head"), parts.head},
    {QStringLiteral("tail"), parts.tail},
    {QStringLiteral("defaultUser"), MpvConfigManager::defaultUser()},
    {QStringLiteral("defaultUpdated"), MpvConfigManager::defaultUpdated()},
    {QStringLiteral("configDir"), MpvConfigManager::activeConfigDir()},
    {QStringLiteral("configPath"), MpvConfigManager::userConfigPath()},
    {QStringLiteral("shaderDir"), MpvConfigManager::shaderDir()},
    {QStringLiteral("userShaderDir"), MpvConfigManager::userShaderDir()},
    {QStringLiteral("backupPath"), MpvConfigManager::backupPath()},
    {QStringLiteral("aiGuidePath"), MpvConfigManager::aiGuidePath()},
    {QStringLiteral("aiGuide"), MpvConfigManager::aiGuide()},
    {QStringLiteral("catalog"), QJsonDocument(MpvConfigManager::rules().catalog).toVariant()},
    {QStringLiteral("shaders"), readJsonResource(QStringLiteral(":/mpvconf/shaders.json"))},
    {QStringLiteral("userShaders"), userShaders()},
    {QStringLiteral("activeProfile"), activeProfile},
    {QStringLiteral("missingShaders"), MpvConfigManager::missingShaders()},
  };
  result.insert(QStringLiteral("analysis"), analyze(parts.user, activeProfile));
  return result;
}

QVariantMap edit(const QString& user, const QVariantMap& operation)
{
  const QString type = operation.value(QStringLiteral("type")).toString();
  const QString section = operation.value(QStringLiteral("section"), QStringLiteral("default")).toString();
  const QString key = operation.value(QStringLiteral("key")).toString();
  const QString value = operation.value(QStringLiteral("value")).toString();
  const QString comment = operation.value(QStringLiteral("comment")).toString();
  const QList<MpvConf::Line> lines = MpvConf::parse(user);
  const int lineCount = int(lines.size());
  int afterLine = operation.value(QStringLiteral("afterLine"), -1).toInt();

  if (type == QStringLiteral("set"))
    return {{QStringLiteral("user"), MpvConf::setOption(user, section, key, value, comment)}};
  if (type == QStringLiteral("remove"))
    return {{QStringLiteral("user"), MpvConf::removeOption(user, section, key)}};

  if (type == QStringLiteral("newProfile"))
  {
    const QString name = operation.value(QStringLiteral("name")).toString().trimmed().toLower();
    static const QRegularExpression pattern(QStringLiteral("^[a-z0-9][a-z0-9-]{0,40}$"));
    if (!pattern.match(name).hasMatch())
      return failure(QStringLiteral("档位名只能用小写字母、数字和短横线"));
    const QString full = QStringLiteral("tigerest-user-") + name;
    for (const MpvConf::Line& line : lines)
      if (line.kind == MpvConf::Line::Section && line.section == full)
        return failure(QStringLiteral("已经有名为 %1 的档位").arg(full));
    const QString base = operation.value(QStringLiteral("base")).toString();
    QString description = operation.value(QStringLiteral("description")).toString().trimmed();
    if (description.isEmpty())
      description = name;
    QStringList block{QString(), QStringLiteral("# 自定义档位：%1").arg(description), QStringLiteral("[%1]").arg(full),
                      QStringLiteral("# UOSC 和设置页显示的档位名称。"),
                      MpvConf::formatOption(QStringLiteral("profile-desc"), description)};
    if (!base.isEmpty())
    {
      block << QStringLiteral("# 以「%1」为基础，下面写的项会覆盖它。").arg(base);
      block << MpvConf::formatOption(QStringLiteral("profile"), base);
    }
    return {{QStringLiteral("user"), MpvConf::insertLines(user, lineCount, block)},
            {QStringLiteral("profile"), full}};
  }

  if (type == QStringLiteral("filter"))
  {
    if (afterLine < 0)
      afterLine = lastGlobalOption(lines);
    if (sectionAfter(lines, afterLine) != QStringLiteral("default"))
      return failure(QStringLiteral("vf 滤镜只能加在全局部分（第一个档位之前）"));
    const QString name = operation.value(QStringLiteral("filter")).toString().trimmed();
    const QString params = operation.value(QStringLiteral("params")).toString().trimmed();
    if (name.isEmpty())
      return failure(QStringLiteral("请选择滤镜"));
    const QString entry = QStringLiteral("@%1:%2%3").arg(nextFilterLabel(lines), name,
                                                         params.isEmpty() ? QString() : '=' + params);
    QStringList block;
    if (!comment.isEmpty())
      block << QStringLiteral("# ") + comment;
    block << MpvConf::formatOption(QStringLiteral("vf-append"), entry);
    return {{QStringLiteral("user"), MpvConf::insertLines(user, afterLine, block)}};
  }

  if (type == QStringLiteral("shader"))
  {
    const QString path = operation.value(QStringLiteral("path")).toString();
    if (path.isEmpty() || path.contains(QStringLiteral("..")))
      return failure(QStringLiteral("请选择着色器"));
    QStringList block;
    if (!comment.isEmpty())
      block << QStringLiteral("# ") + comment;
    block << MpvConf::formatOption(QStringLiteral("glsl-shader"), QStringLiteral("~~/shaders/") + path);
    if (afterLine < 0 || sectionAfter(lines, afterLine) != section)
      return {{QStringLiteral("user"), MpvConf::appendLines(user, section, block)}};
    return {{QStringLiteral("user"), MpvConf::insertLines(user, afterLine, block)}};
  }

  // A profile's shader chain, written as a whole: its own shader lines go
  // (each with the comment right above it), then an empty glsl-shaders drops
  // what the profile inherits and the chain follows in order.
  if (type == QStringLiteral("replaceShaders"))
  {
    if (section == QStringLiteral("default"))
      return failure(QStringLiteral("着色器链属于档位，不属于全局部分"));
    const QStringList paths = operation.value(QStringLiteral("paths")).toStringList();
    const QStringList titles = operation.value(QStringLiteral("titles")).toStringList();
    for (const QString& path : paths)
      if (path.isEmpty() || path.contains(QStringLiteral("..")))
        return failure(QStringLiteral("请选择着色器"));
    bool exists = false;
    QList<int> dropped;
    for (int i = 0; i < lineCount; ++i)
    {
      const MpvConf::Line& line = lines[i];
      exists = exists || (line.kind == MpvConf::Line::Section && line.section == section);
      if (line.kind != MpvConf::Line::Option || line.section != section)
        continue;
      const QString written = line.key.startsWith(QStringLiteral("--")) ? line.key.mid(2) : line.key;
      if (written != QStringLiteral("glsl-shader") && !written.startsWith(QStringLiteral("glsl-shaders")))
        continue;
      dropped << line.number;
      if (i > 0 && lines[i - 1].kind == MpvConf::Line::Comment && lines[i - 1].section == section)
        dropped << lines[i - 1].number;
    }
    if (!exists)
      return failure(QStringLiteral("没有名为 %1 的档位").arg(section));
    QStringList block{QStringLiteral("# 清空继承来的着色器，下面按顺序重新挂载。"),
                      MpvConf::formatOption(QStringLiteral("glsl-shaders"), QString())};
    for (int i = 0; i < paths.size(); ++i)
    {
      if (!titles.value(i).isEmpty())
        block << QStringLiteral("# ") + titles.value(i);
      block << MpvConf::formatOption(QStringLiteral("glsl-shader"), QStringLiteral("~~/shaders/") + paths[i]);
    }
    return {{QStringLiteral("user"), MpvConf::appendLines(MpvConf::removeLines(user, dropped), section, block)}};
  }

  // Only profiles made here go: the bundled ones come back with every
  // default update, and another profile may not lose the one it builds on.
  if (type == QStringLiteral("deleteProfile"))
  {
    const QString name = operation.value(QStringLiteral("name")).toString();
    if (!name.startsWith(QStringLiteral("tigerest-user-")))
      return failure(QStringLiteral("只能删除自己新建的档位"));
    QStringList dependants;
    QList<int> blocks;      // indexes of this profile's section headers
    for (int i = 0; i < lineCount; ++i)
    {
      const MpvConf::Line& line = lines[i];
      if (line.kind == MpvConf::Line::Section && line.section == name)
        blocks << i;
      if (line.kind == MpvConf::Line::Option && line.key == QStringLiteral("profile") && line.value == name &&
          line.section != name && !dependants.contains(line.section))
        dependants << line.section;
    }
    if (blocks.isEmpty())
      return failure(QStringLiteral("没有名为 %1 的档位").arg(name));
    if (!dependants.isEmpty())
      return failure(QStringLiteral("档位 %1 以它为基础，请先删除或改写那个档位").arg(dependants.join(QStringLiteral("、"))));
    QList<int> dropped;
    for (const int header : blocks)
    {
      int next = header + 1;
      while (next < lineCount && lines[next].kind != MpvConf::Line::Section)
        ++next;
      int end = next;
      if (next < lineCount)
      {
        // The comments right above the next profile introduce that one.
        while (end > header + 1 && lines[end - 1].kind == MpvConf::Line::Comment)
          --end;
        while (end > header + 1 && lines[end - 1].kind == MpvConf::Line::Blank)
          --end;
      }
      int start = header;
      while (start > 0 && lines[start - 1].kind == MpvConf::Line::Comment)
        --start;
      if (start > 0 && lines[start - 1].kind == MpvConf::Line::Blank)
        --start;
      for (int i = start; i < end; ++i)
        dropped << lines[i].number;
    }
    return {{QStringLiteral("user"), MpvConf::removeLines(user, dropped)}};
  }

  if (type == QStringLiteral("insert"))
  {
    if (afterLine < 0)
      afterLine = lineCount;
    QStringList block;
    if (!comment.isEmpty())
      block << QStringLiteral("# ") + comment;
    block << MpvConf::formatOption(key, value);
    return {{QStringLiteral("user"), MpvConf::insertLines(user, afterLine, block)}};
  }
  return failure(QStringLiteral("未知的编辑操作"));
}

QVariantMap paste(const QString& text)
{
  const MpvConf::Parts pasted = MpvConf::split(text);
  if (!pasted.structured)
    return {{QStringLiteral("user"), MpvConf::normalizeNewlines(text)}, {QStringLiteral("ignoredManaged"), 0}};
  const MpvConf::Parts current = MpvConfigManager::readConfig();
  const QStringList currentManaged = (current.head + current.tail).split('\n');
  int changed = 0;
  for (const QString& line : (pasted.head + pasted.tail).split('\n'))
    if (!currentManaged.contains(line))
      ++changed;
  return {{QStringLiteral("user"), pasted.user}, {QStringLiteral("ignoredManaged"), changed}};
}

}
