#ifndef TIGEREST_MPVCONFDOCUMENT_H
#define TIGEREST_MPVCONFDOCUMENT_H

#include <QHash>
#include <QJsonArray>
#include <QJsonObject>
#include <QList>
#include <QString>
#include <QStringList>
#include <QVariantMap>

// The single user-editable mpv.conf: parsing, ownership rules, validation and
// the line edits behind the settings-page editor. Pure text logic, so the
// startup path, the editor bridge and the unit tests share one implementation.
namespace MpvConf
{
  extern const QString HeadBegin;
  extern const QString HeadEnd;
  extern const QString TailBegin;
  extern const QString TailEnd;
  extern const QString SuspendedPrefix;
  extern const QString IgnoredPrefix;

  // A file splits into a managed head, the user area and a managed tail. A
  // file without the markers (an external edit, or a first run) is all user.
  struct Parts
  {
    QString head;
    QString user;
    QString tail;
    bool structured = false;
  };
  Parts split(const QString& text);
  QString compose(const QString& head, const QString& user, const QString& tail);
  QString normalizeNewlines(const QString& text);
  QString sha256(const QString& text);

  struct Line
  {
    enum Kind { Blank, Comment, Section, Option, Suspended, Ignored, Invalid };
    int number = 0;          // 1-based within the user area
    Kind kind = Blank;
    QString raw;
    QString section = QStringLiteral("default");
    QString key;             // as written, without a leading "--"
    QString value;           // unquoted, trailing comment removed
    bool hasValue = false;
    QStringList reasons;     // Suspended / Ignored markers
  };
  QList<Line> parse(const QString& user);
  // Parses a single "key=value" text; returns false when it is not an option.
  bool parseOption(const QString& text, QString* key, QString* value, bool* hasValue);
  QString quoteValue(const QString& value);
  QString formatOption(const QString& key, const QString& value);

  struct Ownership
  {
    enum Kind { Free, Locked, Page };
    Kind kind = Free;
    QString reason;
  };

  struct ConditionalRule
  {
    QString key;
    QStringList filters;
    QStringList contains;
    QStringList values;
    bool hasValues = false;
  };

  struct Conditional
  {
    QString id;
    QString title;
    QString reason;
    QString section;
    QString setting;
    QList<ConditionalRule> rules;
  };

  struct PageGroup
  {
    QString page;
    QString section;
    QStringList keys;
    QString unlessSection;
    QString unlessKey;
    QString unlessValue;
  };

  class Rules
  {
  public:
    static Rules fromJson(const QJsonObject& catalog, const QJsonObject& mpvOptions);

    QString baseKey(const QString& key) const;
    bool knownOption(const QString& key) const;
    QJsonObject optionInfo(const QString& key) const;
    Ownership ownership(const QString& key, const QVariantMap& settings) const;
    // Conditionals (by id) that are active in `settings` and match the line.
    QStringList suspendReasons(const QString& key, const QString& value, const QVariantMap& settings) const;
    bool conditionalActive(const Conditional& conditional, const QVariantMap& settings) const;

    QJsonObject catalog;
    QHash<QString, QString> locked;
    QList<PageGroup> pages;
    QList<Conditional> conditionals;
    QHash<QString, QJsonObject> mpvOptions;
  };

  struct Diagnostic
  {
    int line = 0;
    QString severity;   // error | warning | info
    QString code;
    QString message;
  };

  struct ValidationContext
  {
    QVariantMap settings;   // "section.key" -> value
    QString configDir;      // resolves "~~/" in shader paths
  };
  QList<Diagnostic> validate(const QString& user, const Rules& rules, const ValidationContext& context);

  // Comments out lines that conflict with an enabled feature and restores
  // lines whose every suspending feature is off again.
  struct SuspensionResult
  {
    QString user;
    QStringList suspended;
    QStringList restored;
  };
  SuspensionResult applySuspension(const QString& user, const Rules& rules, const QVariantMap& settings);

  // Comments out options the user area may not hold, e.g. after an external
  // edit. These stay commented; the editor reports them.
  struct LockResult
  {
    QString user;
    QStringList ignored;
  };
  LockResult neutralizeLocked(const QString& user, const Rules& rules, const QVariantMap& settings);

  // Editor operations. `section` "default" is the global part of the file.
  QString setOption(const QString& user, const QString& section, const QString& key,
                    const QString& value, const QString& comment = QString());
  QString removeOption(const QString& user, const QString& section, const QString& key);
  // Adds lines after the last option of `section` (creating it if needed).
  QString appendLines(const QString& user, const QString& section, const QStringList& lines);
  QString insertLines(const QString& user, int afterLine, const QStringList& lines);
  // Removes whole lines by their 1-based numbers.
  QString removeLines(const QString& user, const QList<int>& numbers);

  struct ResolvedValue
  {
    bool found = false;
    QString value;
    QString section;
    int line = 0;
  };
  // The value `key` takes inside `section`, following profile= inheritance
  // inside the file; falls back to the global part.
  ResolvedValue resolveValue(const QList<Line>& lines, const QString& section, const QString& key);

  struct ProfileInfo
  {
    QString name;
    QString description;
    int line = 0;
  };
  QList<ProfileInfo> profiles(const QList<Line>& lines);

  // Host-side profile application: builtin mpv profiles are applied by name,
  // everything else as option assignments in file order.
  struct ProfileStep
  {
    bool builtin = false;
    QString key;
    QString value;
  };
  QList<ProfileStep> resolveProfile(const QList<Line>& lines, const QString& name, QString* error = nullptr);
  int shaderCount(const QList<ProfileStep>& steps);

  struct ShaderReference
  {
    int line = 0;
    QString written;
    QString resolved;
  };
  QList<ShaderReference> shaderReferences(const QList<Line>& lines, const QString& configDir);
  QString expandPath(const QString& path, const QString& configDir);

  // Splits a vf value into entries, respecting [..] and quoted parameters.
  struct FilterEntry
  {
    QString label;
    QString name;
    QString params;
    QString text;
  };
  QList<FilterEntry> parseFilters(const QString& value);
  bool isFilterKey(const QString& baseKey);

  QStringList builtinProfiles();
}

#endif
