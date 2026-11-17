#include "MpvConfDocument.h"

#include <QCryptographicHash>
#include <QDir>
#include <QFileInfo>
#include <QJsonValue>
#include <QRegularExpression>
#include <QSet>
#include <QStandardPaths>

#include <algorithm>
#include <functional>

namespace MpvConf
{
const QString HeadBegin = QStringLiteral("# ==== 大河影院管理区·头部（只读）====");
const QString HeadEnd = QStringLiteral("# ==== 头部结束 ====");
const QString TailBegin = QStringLiteral("# ==== 大河影院管理区·尾部（只读，每次启动由软件重写）====");
const QString TailEnd = QStringLiteral("# ==== 尾部结束 ====");
const QString SuspendedPrefix = QStringLiteral("#[暂停执行:");
const QString IgnoredPrefix = QStringLiteral("#[已忽略:");
}

namespace
{
const QStringList ListSuffixes = {
  QStringLiteral("-append"), QStringLiteral("-add"), QStringLiteral("-pre"), QStringLiteral("-set"),
  QStringLiteral("-clr"), QStringLiteral("-remove"), QStringLiteral("-del"), QStringLiteral("-toggle")};

// Filters that run on GPU frames or only retag them, so hardware decoding
// without copy-back does not affect them.
const QStringList GpuFilters = {
  QStringLiteral("gpu"), QStringLiteral("format"), QStringLiteral("sub"), QStringLiteral("d3d11vpp"),
  QStringLiteral("vavpp"), QStringLiteral("scale_vt"), QStringLiteral("transpose_vt"),
  QStringLiteral("yadif_videotoolbox"), QStringLiteral("hwdownload"), QStringLiteral("hwupload"),
  QStringLiteral("hwmap")};

const QStringList FrameRateFilters = {
  QStringLiteral("fps"), QStringLiteral("framerate"), QStringLiteral("minterpolate"), QStringLiteral("tinterlace"),
  QStringLiteral("decimate"), QStringLiteral("mpdecimate"), QStringLiteral("telecine"), QStringLiteral("framestep"),
  QStringLiteral("vapoursynth")};

const QRegularExpression& keyPattern()
{
  static const QRegularExpression pattern(QStringLiteral("^[A-Za-z0-9][A-Za-z0-9_./-]*$"));
  return pattern;
}

QStringList splitLines(const QString& text)
{
  QStringList lines = MpvConf::normalizeNewlines(text).split('\n');
  // A trailing newline produces one empty element that is not a line.
  if (!lines.isEmpty() && lines.last().isEmpty())
    lines.removeLast();
  return lines;
}

QString joinLines(const QStringList& lines)
{
  return lines.isEmpty() ? QString() : lines.join('\n') + '\n';
}

QString settingText(const QVariantMap& settings, const QString& section, const QString& key)
{
  return settings.value(section + '.' + key).toString();
}

QStringList listValues(const QString& value)
{
  QStringList result;
  for (const QString& item : value.split(QDir::listSeparator()))
    if (!item.trimmed().isEmpty())
      result << item.trimmed();
  return result;
}

int sectionEnd(const QList<MpvConf::Line>& lines, int headerIndex)
{
  for (int i = headerIndex + 1; i < lines.size(); ++i)
    if (lines[i].kind == MpvConf::Line::Section)
      return i;
  return int(lines.size());
}

bool sameKey(const QString& written, const QString& key)
{
  QString a = written;
  if (a.startsWith(QStringLiteral("--")))
    a = a.mid(2);
  return a == key;
}
}

namespace MpvConf
{

QString normalizeNewlines(const QString& text)
{
  QString result = text;
  result.replace(QStringLiteral("\r\n"), QStringLiteral("\n"));
  result.replace('\r', '\n');
  return result;
}

QString sha256(const QString& text)
{
  return QString::fromLatin1(QCryptographicHash::hash(normalizeNewlines(text).toUtf8(),
                                                      QCryptographicHash::Sha256).toHex());
}

Parts split(const QString& text)
{
  Parts parts;
  const QStringList lines = splitLines(text);
  const qsizetype headBegin = lines.indexOf(HeadBegin);
  const qsizetype headEnd = headBegin >= 0 ? lines.indexOf(HeadEnd, headBegin) : -1;
  const qsizetype tailBegin = lines.indexOf(TailBegin, headEnd >= 0 ? headEnd : 0);
  const qsizetype tailEnd = tailBegin >= 0 ? lines.indexOf(TailEnd, tailBegin) : -1;
  if (headBegin < 0 || headEnd < 0 || tailBegin < 0 || tailEnd < 0)
  {
    parts.user = joinLines(lines);
    return parts;
  }
  parts.structured = true;
  parts.head = joinLines(lines.mid(headBegin, headEnd - headBegin + 1));
  // Text an external editor put outside the managed blocks belongs to the
  // user area: before the head goes first, after the tail goes last.
  QStringList user = lines.mid(0, headBegin) + lines.mid(headEnd + 1, tailBegin - headEnd - 1);
  const QStringList trailing = lines.mid(tailEnd + 1);
  // compose() separates the blocks with one blank line on each side.
  if (!user.isEmpty() && user.first().isEmpty())
    user.removeFirst();
  if (!user.isEmpty() && user.last().isEmpty())
    user.removeLast();
  bool hasTrailing = false;
  for (const QString& line : trailing)
    hasTrailing = hasTrailing || !line.trimmed().isEmpty();
  if (hasTrailing)
    user << trailing;
  parts.user = joinLines(user);
  parts.tail = joinLines(lines.mid(tailBegin, tailEnd - tailBegin + 1));
  return parts;
}

QString compose(const QString& head, const QString& user, const QString& tail)
{
  QString body = normalizeNewlines(user);
  while (body.endsWith(QStringLiteral("\n\n")))
    body.chop(1);
  if (!body.isEmpty() && !body.endsWith('\n'))
    body += '\n';
  return normalizeNewlines(head) + '\n' + body + '\n' + normalizeNewlines(tail);
}

bool parseOption(const QString& text, QString* key, QString* value, bool* hasValue)
{
  QString line = text.trimmed();
  if (line.startsWith(QStringLiteral("--")))
    line = line.mid(2);
  if (line.isEmpty() || line.startsWith('#') || line.startsWith('['))
    return false;
  const qsizetype equals = line.indexOf('=');
  QString name;
  QString parsed;
  bool assigned = false;
  if (equals < 0)
  {
    const qsizetype comment = line.indexOf('#');
    name = (comment < 0 ? line : line.left(comment)).trimmed();
  }
  else
  {
    name = line.left(equals).trimmed();
    assigned = true;
    QString rest = line.mid(equals + 1);
    while (!rest.isEmpty() && rest.front().isSpace())
      rest.remove(0, 1);
    QString remainder;
    if (rest.startsWith('"') || rest.startsWith('\''))
    {
      const QChar quote = rest.front();
      const qsizetype close = rest.indexOf(quote, 1);
      if (close < 0)
        return false;
      parsed = rest.mid(1, close - 1);
      remainder = rest.mid(close + 1).trimmed();
    }
    else if (rest.startsWith('%'))
    {
      static const QRegularExpression lengthPattern(QStringLiteral("^%(\\d+)%"));
      const auto match = lengthPattern.match(rest);
      if (!match.hasMatch())
        return false;
      const QByteArray bytes = rest.mid(match.capturedLength()).toUtf8();
      const int length = match.captured(1).toInt();
      if (length > bytes.size())
        return false;
      parsed = QString::fromUtf8(bytes.left(length));
      remainder = QString::fromUtf8(bytes.mid(length)).trimmed();
    }
    else
    {
      const qsizetype comment = rest.indexOf('#');
      parsed = (comment < 0 ? rest : rest.left(comment)).trimmed();
    }
    if (!remainder.isEmpty() && !remainder.startsWith('#'))
      return false;
  }
  if (!keyPattern().match(name).hasMatch())
    return false;
  if (key)
    *key = name;
  if (value)
    *value = parsed;
  if (hasValue)
    *hasValue = assigned;
  return true;
}

QList<Line> parse(const QString& user)
{
  QList<Line> result;
  QString section = QStringLiteral("default");
  const QStringList lines = splitLines(user);
  for (int i = 0; i < lines.size(); ++i)
  {
    Line line;
    line.number = i + 1;
    line.raw = lines[i];
    const QString trimmed = line.raw.trimmed();
    if (trimmed.isEmpty())
    {
      line.kind = Line::Blank;
    }
    else if (trimmed.startsWith(SuspendedPrefix) || trimmed.startsWith(IgnoredPrefix))
    {
      const bool suspended = trimmed.startsWith(SuspendedPrefix);
      const qsizetype close = trimmed.indexOf(']');
      const QString prefix = suspended ? SuspendedPrefix : IgnoredPrefix;
      if (close < 0)
      {
        line.kind = Line::Comment;
      }
      else
      {
        line.kind = suspended ? Line::Suspended : Line::Ignored;
        const QString reasons = trimmed.mid(prefix.size(), close - prefix.size());
        line.reasons = suspended ? reasons.split(',', Qt::SkipEmptyParts) : QStringList{reasons};
        parseOption(trimmed.mid(close + 1), &line.key, &line.value, &line.hasValue);
      }
    }
    else if (trimmed.startsWith('#'))
    {
      line.kind = Line::Comment;
    }
    else if (trimmed.startsWith('['))
    {
      if (trimmed.endsWith(']') && trimmed.size() > 2)
      {
        line.kind = Line::Section;
        section = trimmed.mid(1, trimmed.size() - 2).trimmed();
      }
      else
      {
        line.kind = Line::Invalid;
      }
    }
    else if (parseOption(trimmed, &line.key, &line.value, &line.hasValue))
    {
      line.kind = Line::Option;
      if (line.key.startsWith(QStringLiteral("--")))
        line.key = line.key.mid(2);
    }
    else
    {
      line.kind = Line::Invalid;
    }
    line.section = section;
    result << line;
  }
  return result;
}

QString quoteValue(const QString& value)
{
  const bool plain = !value.contains('#') && value.trimmed() == value &&
                     !value.startsWith('"') && !value.startsWith('\'') && !value.startsWith('%');
  if (plain)
    return value;
  if (!value.contains('"'))
    return '"' + value + '"';
  return QStringLiteral("%%1%").arg(value.toUtf8().size()) + value;
}

QString formatOption(const QString& key, const QString& value)
{
  return key + '=' + quoteValue(value);
}

Rules Rules::fromJson(const QJsonObject& catalog, const QJsonObject& mpvOptions)
{
  Rules rules;
  rules.catalog = catalog;
  for (const QJsonValue& entry : catalog.value(QStringLiteral("locked")).toArray())
  {
    const QJsonObject object = entry.toObject();
    for (const QJsonValue& key : object.value(QStringLiteral("keys")).toArray())
      rules.locked.insert(key.toString(), object.value(QStringLiteral("reason")).toString());
  }
  for (const QJsonValue& entry : catalog.value(QStringLiteral("pageOwned")).toArray())
  {
    const QJsonObject object = entry.toObject();
    PageGroup group;
    group.page = object.value(QStringLiteral("page")).toString();
    group.section = object.value(QStringLiteral("section")).toString();
    for (const QJsonValue& key : object.value(QStringLiteral("keys")).toArray())
      group.keys << key.toString();
    const QJsonArray unless = object.value(QStringLiteral("unlessSetting")).toArray();
    if (unless.size() == 3)
    {
      group.unlessSection = unless[0].toString();
      group.unlessKey = unless[1].toString();
      group.unlessValue = unless[2].toString();
    }
    rules.pages << group;
  }
  for (const QJsonValue& entry : catalog.value(QStringLiteral("conditional")).toArray())
  {
    const QJsonObject object = entry.toObject();
    Conditional conditional;
    conditional.id = object.value(QStringLiteral("id")).toString();
    conditional.title = object.value(QStringLiteral("title")).toString();
    conditional.reason = object.value(QStringLiteral("reason")).toString();
    const QJsonArray setting = object.value(QStringLiteral("setting")).toArray();
    conditional.section = setting.at(0).toString();
    conditional.setting = setting.at(1).toString();
    for (const QJsonValue& ruleValue : object.value(QStringLiteral("rules")).toArray())
    {
      const QJsonObject ruleObject = ruleValue.toObject();
      ConditionalRule rule;
      rule.key = ruleObject.value(QStringLiteral("key")).toString();
      for (const QJsonValue& item : ruleObject.value(QStringLiteral("filters")).toArray())
        rule.filters << item.toString();
      for (const QJsonValue& item : ruleObject.value(QStringLiteral("contains")).toArray())
        rule.contains << item.toString();
      rule.hasValues = ruleObject.contains(QStringLiteral("values"));
      for (const QJsonValue& item : ruleObject.value(QStringLiteral("values")).toArray())
        rule.values << item.toString();
      conditional.rules << rule;
    }
    rules.conditionals << conditional;
  }
  const QJsonObject options = mpvOptions.value(QStringLiteral("options")).toObject();
  for (auto it = options.begin(); it != options.end(); ++it)
    rules.mpvOptions.insert(it.key(), it.value().toObject());
  return rules;
}

QString Rules::baseKey(const QString& key) const
{
  QString name = key.startsWith(QStringLiteral("--")) ? key.mid(2) : key;
  if (name == QStringLiteral("glsl-shader"))
    return QStringLiteral("glsl-shaders");
  if (name == QStringLiteral("script-opt"))
    return QStringLiteral("script-opts");
  if (mpvOptions.contains(name))
    return name;
  if (name.startsWith(QStringLiteral("no-")))
  {
    const QString flag = name.mid(3);
    if (mpvOptions.value(flag).value(QStringLiteral("type")).toString() == QStringLiteral("Flag"))
      return flag;
  }
  for (const QString& suffix : ListSuffixes)
  {
    if (!name.endsWith(suffix))
      continue;
    const QString base = name.left(name.size() - suffix.size());
    if (mpvOptions.contains(base) || base == QStringLiteral("vf") || base == QStringLiteral("glsl-shaders") ||
        base == QStringLiteral("script-opts") || base == QStringLiteral("af"))
      return base;
  }
  return name;
}

bool Rules::knownOption(const QString& key) const
{
  static const QStringList special = {
    QStringLiteral("profile"), QStringLiteral("profile-desc"), QStringLiteral("profile-cond"),
    QStringLiteral("profile-restore"), QStringLiteral("include")};
  const QString base = baseKey(key);
  return special.contains(base) || mpvOptions.contains(base) || mpvOptions.isEmpty();
}

QJsonObject Rules::optionInfo(const QString& key) const
{
  return mpvOptions.value(baseKey(key));
}

Ownership Rules::ownership(const QString& key, const QVariantMap& settings) const
{
  const QString name = key.startsWith(QStringLiteral("--")) ? key.mid(2) : key;
  const QString base = baseKey(name);
  for (const QString& candidate : {name, base})
  {
    if (locked.contains(candidate))
      return {Ownership::Locked, locked.value(candidate)};
  }
  for (const PageGroup& group : pages)
  {
    if (!group.keys.contains(base))
      continue;
    if (!group.unlessKey.isEmpty() &&
        settingText(settings, group.unlessSection, group.unlessKey) == group.unlessValue)
      continue;
    return {Ownership::Page, QStringLiteral("由「%1」设置页决定").arg(group.page)};
  }
  return {};
}

bool Rules::conditionalActive(const Conditional& conditional, const QVariantMap& settings) const
{
  return settings.value(conditional.section + '.' + conditional.setting).toBool();
}

QStringList Rules::suspendReasons(const QString& key, const QString& value, const QVariantMap& settings) const
{
  QStringList reasons;
  const QString base = baseKey(key);
  for (const Conditional& conditional : conditionals)
  {
    if (!conditionalActive(conditional, settings))
      continue;
    bool matched = false;
    for (const ConditionalRule& rule : conditional.rules)
    {
      if (rule.key != base)
        continue;
      if (rule.hasValues)
      {
        QString normalized = value;
        if (key.startsWith(QStringLiteral("no-")))
          normalized = QStringLiteral("no");
        matched = rule.values.contains(normalized);
      }
      if (!matched && isFilterKey(base))
      {
        for (const FilterEntry& filter : parseFilters(value))
        {
          const QString haystack = (filter.label + ' ' + filter.name + ' ' + filter.params).toLower();
          if (rule.filters.contains(filter.name.toLower()))
            matched = true;
          for (const QString& needle : rule.contains)
            matched = matched || haystack.contains(needle);
        }
      }
      if (matched)
        break;
    }
    if (matched)
      reasons << conditional.id;
  }
  return reasons;
}

bool isFilterKey(const QString& baseKey)
{
  return baseKey == QStringLiteral("vf");
}

QList<FilterEntry> parseFilters(const QString& value)
{
  QList<FilterEntry> result;
  QStringList pieces;
  QString current;
  int depth = 0;
  QChar quote;
  for (const QChar c : value)
  {
    if (!quote.isNull())
    {
      if (c == quote)
        quote = QChar();
    }
    else if (c == '"' || c == '\'')
    {
      quote = c;
    }
    else if (c == '[')
    {
      ++depth;
    }
    else if (c == ']')
    {
      depth = qMax(0, depth - 1);
    }
    else if (c == ',' && depth == 0)
    {
      pieces << current;
      current.clear();
      continue;
    }
    current += c;
  }
  pieces << current;
  for (const QString& piece : pieces)
  {
    const QString text = piece.trimmed();
    if (text.isEmpty())
      continue;
    FilterEntry entry;
    entry.text = text;
    QString rest = text;
    if (rest.startsWith('@'))
    {
      const qsizetype colon = rest.indexOf(':');
      entry.label = (colon < 0 ? rest.mid(1) : rest.mid(1, colon - 1)).trimmed();
      rest = colon < 0 ? QString() : rest.mid(colon + 1);
    }
    const qsizetype equals = rest.indexOf('=');
    entry.name = (equals < 0 ? rest : rest.left(equals)).trimmed();
    entry.params = equals < 0 ? QString() : rest.mid(equals + 1);
    if (entry.name.startsWith('!'))
      entry.name = entry.name.mid(1);
    result << entry;
  }
  return result;
}

QStringList builtinProfiles()
{
  return {QStringLiteral("default"), QStringLiteral("high-quality"), QStringLiteral("gpu-hq"),
          QStringLiteral("fast"), QStringLiteral("sw-fast"), QStringLiteral("low-latency"),
          QStringLiteral("pseudo-gui"), QStringLiteral("builtin-pseudo-gui"), QStringLiteral("libmpv"),
          QStringLiteral("encoding"), QStringLiteral("box"), QStringLiteral("osd-box"),
          QStringLiteral("sub-box")};
}

QString expandPath(const QString& path, const QString& configDir)
{
  QString value = path.trimmed();
  if (value.startsWith(QStringLiteral("~~/")))
    return QDir(configDir).filePath(value.mid(3));
  if (value.startsWith(QStringLiteral("~~home/")))
    return QDir(configDir).filePath(value.mid(7));
  if (value.startsWith(QStringLiteral("~/")))
    return QDir(QStandardPaths::writableLocation(QStandardPaths::HomeLocation)).filePath(value.mid(2));
  if (QDir::isRelativePath(value))
    return QDir(configDir).filePath(value);
  return value;
}

QList<ShaderReference> shaderReferences(const QList<Line>& lines, const QString& configDir)
{
  QList<ShaderReference> result;
  for (const Line& line : lines)
  {
    if (line.kind != Line::Option)
      continue;
    const QString key = line.key;
    QStringList paths;
    if (key == QStringLiteral("glsl-shader") || key == QStringLiteral("glsl-shaders-append") ||
        key == QStringLiteral("glsl-shaders-add") || key == QStringLiteral("glsl-shaders-pre"))
      paths << line.value;
    else if (key == QStringLiteral("glsl-shaders") || key == QStringLiteral("glsl-shaders-set"))
      paths = listValues(line.value);
    for (const QString& path : paths)
    {
      if (path.trimmed().isEmpty())
        continue;
      result << ShaderReference{line.number, path, expandPath(path, configDir)};
    }
  }
  return result;
}

QList<ProfileInfo> profiles(const QList<Line>& lines)
{
  QList<ProfileInfo> result;
  QHash<QString, int> index;
  for (const Line& line : lines)
  {
    if (line.kind == Line::Section && line.section != QStringLiteral("default") && !index.contains(line.section))
    {
      index.insert(line.section, int(result.size()));
      result << ProfileInfo{line.section, QString(), line.number};
    }
    if (line.kind == Line::Option && line.key == QStringLiteral("profile-desc") && index.contains(line.section))
      result[index.value(line.section)].description = line.value;
  }
  return result;
}

namespace
{
void resolveInto(const QList<Line>& lines, const QString& name, QStringList& stack,
                 QList<ProfileStep>& steps, QString* error)
{
  if (stack.contains(name))
  {
    if (error)
      *error = QStringLiteral("档位 %1 循环引用了自己").arg(name);
    return;
  }
  stack << name;
  QSet<QString> defined;
  for (const Line& line : lines)
    if (line.kind == Line::Section)
      defined.insert(line.section);
  for (const Line& line : lines)
  {
    if (line.kind != Line::Option || line.section != name)
      continue;
    if (line.key == QStringLiteral("profile"))
    {
      for (const QString& parent : line.value.split(',', Qt::SkipEmptyParts))
      {
        const QString trimmed = parent.trimmed();
        if (defined.contains(trimmed) && trimmed != QStringLiteral("default"))
          resolveInto(lines, trimmed, stack, steps, error);
        else
          steps << ProfileStep{true, QStringLiteral("profile"), trimmed};
      }
      continue;
    }
    if (line.key == QStringLiteral("profile-desc") || line.key == QStringLiteral("profile-cond") ||
        line.key == QStringLiteral("profile-restore"))
      continue;
    steps << ProfileStep{false, line.key, line.hasValue ? line.value : QStringLiteral("yes")};
  }
  stack.removeLast();
}
}

QList<ProfileStep> resolveProfile(const QList<Line>& lines, const QString& name, QString* error)
{
  QList<ProfileStep> steps;
  bool exists = false;
  for (const Line& line : lines)
    exists = exists || (line.kind == Line::Section && line.section == name);
  if (!exists)
  {
    if (error)
      *error = QStringLiteral("配置文件里没有档位 %1").arg(name);
    return steps;
  }
  QStringList stack;
  resolveInto(lines, name, stack, steps, error);
  return steps;
}

int shaderCount(const QList<ProfileStep>& steps)
{
  QStringList shaders;
  for (const ProfileStep& step : steps)
  {
    if (step.builtin)
      continue;
    const QString& key = step.key;
    if (key == QStringLiteral("glsl-shaders") || key == QStringLiteral("glsl-shaders-set"))
      shaders = listValues(step.value);
    else if (key == QStringLiteral("glsl-shaders-clr"))
      shaders.clear();
    else if (key == QStringLiteral("glsl-shader") || key == QStringLiteral("glsl-shaders-append") ||
             key == QStringLiteral("glsl-shaders-add"))
      shaders << step.value;
    else if (key == QStringLiteral("glsl-shaders-pre"))
      shaders.prepend(step.value);
    else if (key == QStringLiteral("glsl-shaders-remove"))
      shaders.removeAll(step.value);
  }
  shaders.removeAll(QString());
  return int(shaders.size());
}

ResolvedValue resolveValue(const QList<Line>& lines, const QString& section, const QString& key)
{
  std::function<ResolvedValue(const QString&, int)> lookup = [&](const QString& name, int depth) -> ResolvedValue {
    if (depth > 16)
      return {};
    ResolvedValue explicitValue;
    QStringList parents;
    for (const Line& line : lines)
    {
      if (line.kind != Line::Option || line.section != name)
        continue;
      if (sameKey(line.key, key))
        explicitValue = {true, line.hasValue ? line.value : QStringLiteral("yes"), name, line.number};
      else if (line.key == QStringLiteral("profile"))
        parents << line.value.split(',', Qt::SkipEmptyParts);
    }
    if (explicitValue.found)
      return explicitValue;
    for (qsizetype i = parents.size() - 1; i >= 0; --i)
    {
      const QString parent = parents[i].trimmed();
      if (parent == name)
        continue;
      ResolvedValue inherited = lookup(parent, depth + 1);
      if (inherited.found)
        return inherited;
    }
    return {};
  };
  ResolvedValue value = lookup(section, 0);
  if (!value.found && section != QStringLiteral("default"))
    value = lookup(QStringLiteral("default"), 0);
  return value;
}

QList<Diagnostic> validate(const QString& user, const Rules& rules, const ValidationContext& context)
{
  QList<Diagnostic> result;
  const QList<Line> lines = parse(user);
  QSet<QString> sections;
  for (const Line& line : lines)
    if (line.kind == Line::Section)
      sections.insert(line.section);
  const QStringList builtins = builtinProfiles();
  const bool rifeActive = context.settings.value(QStringLiteral("video.aiRife")).toBool();
  const QString hwdec = context.settings.value(QStringLiteral("video.hardwareDecoding")).toString();
  const bool copyBack = hwdec == QStringLiteral("copy") || hwdec == QStringLiteral("disabled") || hwdec.isEmpty();
  const QStringList filterNames = [&] {
    QStringList names;
    for (const QJsonValue& value : rules.mpvOptions.value(QStringLiteral("vf")).value(QStringLiteral("choices")).toArray())
      names << value.toString();
    return names;
  }();
  QHash<QString, int> seenKeys;
  QHash<QString, int> seenSections;
  QHash<QString, int> filterLabels;
  auto add = [&](int line, const QString& severity, const QString& code, const QString& message) {
    result << Diagnostic{line, severity, code, message};
  };

  for (const Line& line : lines)
  {
    switch (line.kind)
    {
    case Line::Invalid:
      add(line.number, QStringLiteral("error"), QStringLiteral("syntax"),
          QStringLiteral("无法识别的写法：应为 key=value、[档位名] 或以 # 开头的注释"));
      continue;
    case Line::Section:
      if (seenSections.contains(line.section) && line.section != QStringLiteral("default"))
        add(line.number, QStringLiteral("warning"), QStringLiteral("duplicate-section"),
            QStringLiteral("档位 %1 在第 %2 行已经定义过，这里的内容会追加到同一档位")
                .arg(line.section).arg(seenSections.value(line.section)));
      else
        seenSections.insert(line.section, line.number);
      continue;
    case Line::Ignored:
      add(line.number, QStringLiteral("warning"), QStringLiteral("ignored"),
          QStringLiteral("这一行写了不能放在用户区的配置项，已被软件注释，不会执行（%1）").arg(line.reasons.value(0)));
      continue;
    case Line::Suspended:
    {
      QStringList titles;
      for (const Conditional& conditional : rules.conditionals)
        if (line.reasons.contains(conditional.id))
          titles << conditional.title;
      add(line.number, QStringLiteral("info"), QStringLiteral("suspended"),
          QStringLiteral("%1开启中，这一行暂停执行；关闭后自动恢复").arg(titles.join(QStringLiteral("、"))));
      continue;
    }
    case Line::Option:
      break;
    default:
      continue;
    }

    const QString key = line.key;
    const QString base = rules.baseKey(key);
    const bool global = line.section == QStringLiteral("default");

    if (key == QStringLiteral("profile"))
    {
      if (global)
      {
        add(line.number, QStringLiteral("error"), QStringLiteral("locked"),
            QStringLiteral("全局启动档位由上方「画质预设」决定，不能写在用户区；档位段内的 profile= 用于继承，可以使用"));
        continue;
      }
      for (const QString& parent : line.value.split(',', Qt::SkipEmptyParts))
      {
        const QString name = parent.trimmed();
        if (!sections.contains(name) && !builtins.contains(name))
          add(line.number, QStringLiteral("error"), QStringLiteral("missing-profile"),
              QStringLiteral("找不到档位 %1：它既不在这个文件里，也不是 mpv 内置档位").arg(name));
      }
      continue;
    }
    if (key == QStringLiteral("profile-desc") || key == QStringLiteral("profile-cond") ||
        key == QStringLiteral("profile-restore"))
    {
      if (global)
        add(line.number, QStringLiteral("warning"), QStringLiteral("profile-option"),
            QStringLiteral("%1 只在档位段内有意义").arg(key));
      continue;
    }

    const Ownership owner = rules.ownership(key, context.settings);
    if (owner.kind == Ownership::Locked)
    {
      add(line.number, QStringLiteral("error"), QStringLiteral("locked"),
          QStringLiteral("%1 由软件管理，不能写在用户区：%2").arg(key, owner.reason));
      continue;
    }
    if (owner.kind == Ownership::Page)
    {
      add(line.number, QStringLiteral("error"), QStringLiteral("page-owned"),
          QStringLiteral("%1 %2，请到该页修改").arg(key, owner.reason));
      continue;
    }
    if (!rules.knownOption(key))
    {
      add(line.number, QStringLiteral("error"), QStringLiteral("unknown-option"),
          QStringLiteral("mpv 没有 %1 这个配置项").arg(key));
      continue;
    }

    const QJsonObject info = rules.optionInfo(key);
    const QString type = info.value(QStringLiteral("type")).toString();
    const QString value = line.value;
    const bool listOperation = base != key && !key.startsWith(QStringLiteral("no-")) &&
                               key != QStringLiteral("glsl-shader");
    if (key.startsWith(QStringLiteral("no-")) && base != key)
    {
      if (line.hasValue)
        add(line.number, QStringLiteral("error"), QStringLiteral("value"),
            QStringLiteral("%1 的写法不需要等号和值").arg(key));
    }
    else if (!listOperation && type == QStringLiteral("Flag"))
    {
      if (line.hasValue && value != QStringLiteral("yes") && value != QStringLiteral("no"))
        add(line.number, QStringLiteral("error"), QStringLiteral("value"),
            QStringLiteral("%1 只能写 yes 或 no").arg(key));
    }
    else if (!listOperation && (type == QStringLiteral("Integer") || type == QStringLiteral("Int64") ||
                                type == QStringLiteral("Double") || type == QStringLiteral("Float")))
    {
      bool ok = false;
      const bool integer = type == QStringLiteral("Integer") || type == QStringLiteral("Int64");
      const double number = integer ? double(value.toLongLong(&ok)) : value.toDouble(&ok);
      if (!line.hasValue || !ok)
      {
        add(line.number, QStringLiteral("error"), QStringLiteral("value"),
            QStringLiteral("%1 需要%2").arg(key, integer ? QStringLiteral("整数") : QStringLiteral("数字")));
      }
      else if ((info.contains(QStringLiteral("min")) && number < info.value(QStringLiteral("min")).toDouble()) ||
               (info.contains(QStringLiteral("max")) && number > info.value(QStringLiteral("max")).toDouble()))
      {
        add(line.number, QStringLiteral("error"), QStringLiteral("range"),
            QStringLiteral("%1 的取值范围是 %2 到 %3").arg(key)
                .arg(info.value(QStringLiteral("min")).toDouble())
                .arg(info.value(QStringLiteral("max")).toDouble()));
      }
    }
    else if (!listOperation && type == QStringLiteral("Choice"))
    {
      QStringList choices;
      for (const QJsonValue& choice : info.value(QStringLiteral("choices")).toArray())
        choices << choice.toString();
      bool numeric = false;
      value.toDouble(&numeric);
      if (!choices.isEmpty() && !choices.contains(value) && !numeric)
      {
        const QStringList shown = choices.mid(0, 12);
        add(line.number, QStringLiteral("error"), QStringLiteral("value"),
            QStringLiteral("%1 不能写 %2，可选值：%3%4").arg(key, value.isEmpty() ? QStringLiteral("空值") : value,
                                                        shown.join(QStringLiteral(", ")),
                                                        choices.size() > shown.size() ? QStringLiteral(" …") : QString()));
      }
    }
    else if (!listOperation && type == QStringLiteral("ByteSize"))
    {
      static const QRegularExpression sizePattern(QStringLiteral("^\\d+(\\.\\d+)?\\s*([KMGT]i?B?|B)?$"),
                                                  QRegularExpression::CaseInsensitiveOption);
      if (!sizePattern.match(value).hasMatch())
        add(line.number, QStringLiteral("error"), QStringLiteral("value"),
            QStringLiteral("%1 需要大小，例如 50MiB").arg(key));
    }

    if (isFilterKey(base))
    {
      if (!global)
      {
        add(line.number, QStringLiteral("error"), QStringLiteral("vf-scope"),
            QStringLiteral("vf 滤镜只能写在全局部分（第一个档位之前），切档时不会改动滤镜链"));
        continue;
      }
      const bool removes = key.endsWith(QStringLiteral("-remove")) || key.endsWith(QStringLiteral("-clr")) ||
                           key.endsWith(QStringLiteral("-del")) || key.endsWith(QStringLiteral("-toggle"));
      if (key.endsWith(QStringLiteral("-clr")))
      {
        add(line.number, QStringLiteral("error"), QStringLiteral("vf-clear"),
            QStringLiteral("不能清空整条滤镜链，RIFE 与 SVP 也在用它；请删除自己的 vf 行"));
        continue;
      }
      for (const FilterEntry& filter : parseFilters(value))
      {
        if (!filter.label.startsWith(QStringLiteral("user-")))
        {
          add(line.number, QStringLiteral("error"), QStringLiteral("vf-label"),
              QStringLiteral("vf 滤镜必须带 @user- 开头的标签，例如 @user-1:%1").arg(filter.text));
          continue;
        }
        if (removes)
          continue;
        if (filterLabels.contains(filter.label))
          add(line.number, QStringLiteral("error"), QStringLiteral("vf-label"),
              QStringLiteral("标签 @%1 在第 %2 行已经用过").arg(filter.label).arg(filterLabels.value(filter.label)));
        else
          filterLabels.insert(filter.label, line.number);
        if (!filterNames.isEmpty() && !filterNames.contains(filter.name))
          add(line.number, QStringLiteral("error"), QStringLiteral("vf-name"),
              QStringLiteral("mpv 没有名为 %1 的视频滤镜").arg(filter.name));
        if (!rifeActive && FrameRateFilters.contains(filter.name))
          add(line.number, QStringLiteral("warning"), QStringLiteral("vf-framerate"),
              QStringLiteral("%1 会改变帧率或接管插帧；开启 RIFE 时这一行会自动暂停执行").arg(filter.name));
        if (!rifeActive && !copyBack && !GpuFilters.contains(filter.name))
          add(line.number, QStringLiteral("warning"), QStringLiteral("vf-hwdec"),
              QStringLiteral("「视频」页的硬件解码不是回读模式，CPU 滤镜 %1 可能报错或让解码退回软件；建议改用回读（copy）模式")
                  .arg(filter.name));
      }
    }

    if (!rules.suspendReasons(key, value, context.settings).isEmpty())
      add(line.number, QStringLiteral("info"), QStringLiteral("will-suspend"),
          QStringLiteral("与已开启的功能冲突，保存后这一行会被暂停执行"));

    if (base == QStringLiteral("glsl-shaders") && !context.configDir.isEmpty())
    {
      QList<Line> single{line};
      for (const ShaderReference& reference : shaderReferences(single, context.configDir))
        if (!QFileInfo(reference.resolved).isFile())
          add(line.number, QStringLiteral("error"), QStringLiteral("missing-shader"),
              QStringLiteral("找不到着色器文件：%1").arg(reference.written));
    }

    const bool appends = listOperation || key == QStringLiteral("glsl-shader");
    if (!appends)
    {
      const QString identity = line.section + '\n' + key;
      if (seenKeys.contains(identity))
        add(line.number, QStringLiteral("warning"), QStringLiteral("duplicate"),
            QStringLiteral("同一段里第 %1 行已经写过 %2，以后面这一行为准").arg(seenKeys.value(identity)).arg(key));
      seenKeys.insert(identity, line.number);
    }
  }
  return result;
}

SuspensionResult applySuspension(const QString& user, const Rules& rules, const QVariantMap& settings)
{
  SuspensionResult result;
  QStringList output = splitLines(user);
  const QList<Line> lines = parse(user);
  for (const Line& line : lines)
  {
    const int index = line.number - 1;
    if (line.kind == Line::Option)
    {
      const QStringList reasons = rules.suspendReasons(line.key, line.value, settings);
      if (reasons.isEmpty())
        continue;
      output[index] = SuspendedPrefix + reasons.join(',') + QStringLiteral("] ") + line.raw.trimmed();
      result.suspended << line.raw.trimmed();
    }
    else if (line.kind == Line::Suspended)
    {
      const QString original = line.raw.trimmed().mid(line.raw.trimmed().indexOf(']') + 1).trimmed();
      const QStringList reasons = rules.suspendReasons(line.key, line.value, settings);
      if (reasons.isEmpty())
      {
        output[index] = original;
        result.restored << original;
      }
      else if (reasons != line.reasons)
      {
        output[index] = SuspendedPrefix + reasons.join(',') + QStringLiteral("] ") + original;
      }
    }
  }
  result.user = joinLines(output);
  return result;
}

LockResult neutralizeLocked(const QString& user, const Rules& rules, const QVariantMap& settings)
{
  LockResult result;
  QStringList output = splitLines(user);
  for (const Line& line : parse(user))
  {
    if (line.kind != Line::Option)
      continue;
    QString reason;
    if (line.key == QStringLiteral("profile") && line.section == QStringLiteral("default"))
    {
      reason = QStringLiteral("启动档位由画质预设决定");
    }
    else
    {
      const Ownership owner = rules.ownership(line.key, settings);
      if (owner.kind == Ownership::Locked)
        reason = QStringLiteral("软件管理");
      else if (owner.kind == Ownership::Page)
        reason = owner.reason;
      else if (isFilterKey(rules.baseKey(line.key)) && line.section != QStringLiteral("default"))
        reason = QStringLiteral("vf 只能写在全局部分");
    }
    if (reason.isEmpty())
      continue;
    output[line.number - 1] = IgnoredPrefix + reason + QStringLiteral("] ") + line.raw.trimmed();
    result.ignored << line.raw.trimmed();
  }
  result.user = joinLines(output);
  return result;
}

QString appendLines(const QString& user, const QString& section, const QStringList& added)
{
  QStringList output = splitLines(user);
  const QList<Line> lines = parse(user);
  QStringList inserted = added;
  qsizetype insertAt = -1;
  if (section == QStringLiteral("default"))
  {
    qsizetype firstSection = lines.size();
    for (qsizetype i = 0; i < lines.size(); ++i)
      if (lines[i].kind == Line::Section)
      {
        firstSection = i;
        break;
      }
    for (qsizetype i = firstSection - 1; i >= 0; --i)
      if (lines[i].kind == Line::Option || lines[i].kind == Line::Suspended || lines[i].kind == Line::Ignored)
      {
        insertAt = i + 1;
        break;
      }
    if (insertAt < 0)
    {
      // No global option yet: place it above the comment block that
      // introduces the first profile, after the file's opening comments.
      insertAt = firstSection;
      while (insertAt > 0 && lines[insertAt - 1].kind == Line::Comment)
        --insertAt;
      while (insertAt > 0 && lines[insertAt - 1].kind == Line::Blank)
        --insertAt;
      if (insertAt == 0)
        insertAt = firstSection;
      inserted.prepend(QString());
    }
  }
  else
  {
    int header = -1;
    for (int i = 0; i < lines.size(); ++i)
      if (lines[i].kind == Line::Section && lines[i].section == section)
        header = i;
    if (header < 0)
    {
      if (!output.isEmpty() && !output.last().trimmed().isEmpty())
        output << QString();
      output << QStringLiteral("[%1]").arg(section);
      output << inserted;
      return joinLines(output);
    }
    const int end = sectionEnd(lines, header);
    insertAt = header + 1;
    for (int i = end - 1; i > header; --i)
      if (lines[i].kind == Line::Option || lines[i].kind == Line::Suspended || lines[i].kind == Line::Ignored)
      {
        insertAt = i + 1;
        break;
      }
  }
  for (int i = 0; i < inserted.size(); ++i)
    output.insert(insertAt + i, inserted[i]);
  return joinLines(output);
}

QString setOption(const QString& user, const QString& section, const QString& key,
                  const QString& value, const QString& comment)
{
  QStringList output = splitLines(user);
  const QList<Line> lines = parse(user);
  const QString text = formatOption(key, value);
  for (qsizetype i = lines.size() - 1; i >= 0; --i)
  {
    if (lines[i].kind == Line::Option && lines[i].section == section && sameKey(lines[i].key, key))
    {
      output[i] = text;
      return joinLines(output);
    }
  }
  QStringList inserted;
  if (!comment.isEmpty())
    inserted << QStringLiteral("# ") + comment;
  inserted << text;
  return appendLines(user, section, inserted);
}

QString removeOption(const QString& user, const QString& section, const QString& key)
{
  QStringList output = splitLines(user);
  const QList<Line> lines = parse(user);
  for (qsizetype i = lines.size() - 1; i >= 0; --i)
  {
    if (lines[i].kind == Line::Option && lines[i].section == section && sameKey(lines[i].key, key))
    {
      output.removeAt(i);
      break;
    }
  }
  return joinLines(output);
}

QString insertLines(const QString& user, int afterLine, const QStringList& lines)
{
  QStringList output = splitLines(user);
  const int at = qBound(0, afterLine, int(output.size()));
  for (int i = 0; i < lines.size(); ++i)
    output.insert(at + i, lines[i]);
  return joinLines(output);
}

QString removeLines(const QString& user, const QList<int>& numbers)
{
  QStringList output = splitLines(user);
  QList<int> sorted = numbers;
  std::sort(sorted.begin(), sorted.end(), std::greater<int>());
  int previous = 0;
  for (const int number : sorted)
  {
    if (number == previous || number < 1 || number > output.size())
      continue;
    previous = number;
    output.removeAt(number - 1);
  }
  return joinLines(output);
}

}
