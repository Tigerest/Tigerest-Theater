#include <QtTest/QtTest>

#include "Paths.h"
#include "core/ProfileManager.h"
#include "player/MpvConfEditor.h"
#include "player/MpvConfigManager.h"
#include "settings/SettingsComponent.h"
#include "settings/SettingsSection.h"

#include <QFile>
#include <QTemporaryDir>

// MpvConfigManager::prepare() on an isolated profile: migration, upgrades,
// locked lines, the shader library and the managed tail.
class TestMpvConfManager : public QObject
{
  Q_OBJECT

private slots:
  void initTestCase();
  void init();
  void migrationBacksUpLegacyCustomization();
  void untouchedDefaultFollowsUpgrades();
  void editedUserAreaIsKept();
  void externalLockedLinesAreCommentedOut();
  void rifeSuspendsConflictingLinesAtStartup();
  void startupProfileFallsBackToDefault();
  void shaderLibraryKeepsUserFiles();
  void reportsMissingShaders();
  void subtitleFontCoversChinese();
  void editorReplacesAProfilesShaderChain();
  void editorDeletesOnlyProfilesMadeHere();
  void keymapKeepsUserBindings();
  void keymapKeepsHandEditedFile();

private:
  QTemporaryDir m_root;
  QString path(const QString& name) const { return QDir(MpvConfigManager::activeConfigDir()).filePath(name); }
  static QByteArray read(const QString& file)
  {
    QFile input(file);
    return input.open(QIODevice::ReadOnly) ? input.readAll() : QByteArray();
  }
  static void write(const QString& file, const QByteArray& data)
  {
    QDir().mkpath(QFileInfo(file).absolutePath());
    QFile output(file);
    QVERIFY(output.open(QIODevice::WriteOnly | QIODevice::Truncate));
    QCOMPARE(output.write(data), data.size());
  }
  QString user() const { return MpvConfigManager::readConfig().user; }
};

void TestMpvConfManager::initTestCase()
{
  QVERIFY(m_root.isValid());
  Paths::setConfigDir(m_root.path());
  Paths::setCacheDir(m_root.filePath("cache"));
  ProfileManager::Get().setActiveProfile(ProfileManager::createProfile("mpv.conf manager test"));
  QVERIFY(SettingsComponent::Get().componentInitialize());
}

void TestMpvConfManager::init()
{
  auto& settings = SettingsComponent::Get();
  settings.setValue(SETTINGS_SECTION_MPV, "enableUosc", true);
  settings.setValue(SETTINGS_SECTION_MPV, "enableDanmaku", true);
  settings.setValue(SETTINGS_SECTION_MPV, "shaderPreset", "default");
  settings.setValue(SETTINGS_SECTION_VIDEO, "aiRife", false);
}

void TestMpvConfManager::migrationBacksUpLegacyCustomization()
{
  auto& settings = SettingsComponent::Get();
  QVERIFY(!settings.value(SETTINGS_SECTION_MPV, "mpvConfEditorMigrated").toBool());
  const QString bundle = ProfileManager::activeProfile().dataDir("mpv");
  write(QDir(bundle).filePath("user-overrides.conf"), "# 注释\ndeband=no\n");
  settings.setValue(SETTINGS_SECTION_OTHER, "other_conf", "sub-scale=2");
  settings.setValue(SETTINGS_SECTION_MPV, "advancedProfileOverrides", true);
  settings.setValue(SETTINGS_SECTION_MPV, "configMode", "auto");

  QVERIFY(MpvConfigManager::prepare());
  QVERIFY(settings.value(SETTINGS_SECTION_MPV, "mpvConfEditorMigrated").toBool());
  const QString backup = QString::fromUtf8(read(MpvConfigManager::backupPath()));
  QVERIFY(backup.contains("deband=no"));
  QVERIFY(backup.contains("sub-scale=2"));
  QVERIFY(backup.contains("deband-threshold="));
  QVERIFY(backup.contains("旧的 MPV 配置模式"));
  QVERIFY(!QFile::exists(QDir(bundle).filePath("user-overrides.conf")));
  QCOMPARE(settings.value(SETTINGS_SECTION_OTHER, "other_conf").toString(), QString());
  QCOMPARE(settings.value(SETTINGS_SECTION_MPV, "configMode").toString(), QStringLiteral("embedded"));
  QCOMPARE(user(), MpvConfigManager::defaultUser());
  const QString file = QString::fromUtf8(read(path("mpv.conf")));
  QVERIFY(file.startsWith(MpvConf::HeadBegin));
  QVERIFY(file.contains("\nscript=~~/plugins/uosc.lua\n"));
  QVERIFY(file.contains("\nprofile=tigerest-default\n"));
  QVERIFY(QFile::exists(path("mpv.fallback.conf")));
  QVERIFY(QString::fromUtf8(read(MpvConfigManager::aiGuidePath())).contains("tigerest-user-"));
  QVERIFY(!MpvConfigManager::defaultUpdated());
}

void TestMpvConfManager::untouchedDefaultFollowsUpgrades()
{
  QVERIFY(MpvConfigManager::prepare());
  // Pretend the stored user area is an older, unchanged default.
  const QString older = QStringLiteral("# 旧版默认\ncache-pause=yes\n");
  MpvConf::Parts parts = MpvConfigManager::readConfig();
  QString head = parts.head;
  head.replace(QRegularExpression("# 默认配置校验值：\\S+"), QStringLiteral("# 默认配置校验值：") + MpvConf::sha256(older));
  write(path("mpv.conf"), MpvConf::compose(head, older, parts.tail).toUtf8());
  QVERIFY(MpvConfigManager::prepare());
  QCOMPARE(user(), MpvConfigManager::defaultUser());
  QVERIFY(!MpvConfigManager::defaultUpdated());
}

void TestMpvConfManager::editedUserAreaIsKept()
{
  QVERIFY(MpvConfigManager::prepare());
  MpvConf::Parts parts = MpvConfigManager::readConfig();
  const QString edited = parts.user + QStringLiteral("# 我的设置\nosd-level=2\n");
  QString head = parts.head;
  head.replace(QRegularExpression("# 默认配置校验值：\\S+"), QStringLiteral("# 默认配置校验值：") + MpvConf::sha256("older default"));
  write(path("mpv.conf"), MpvConf::compose(head, edited, parts.tail).toUtf8());
  QVERIFY(MpvConfigManager::prepare());
  QCOMPARE(user(), edited);
  QVERIFY(MpvConfigManager::defaultUpdated());
  MpvConfigManager::acknowledgeDefaultUpdate();
  QVERIFY(!MpvConfigManager::defaultUpdated());
  QCOMPARE(user(), edited);
  QVERIFY(MpvConfigManager::restoreDefault().ok);
  QCOMPARE(user(), MpvConfigManager::defaultUser());
  QCOMPARE(QString::fromUtf8(read(path("mpv.conf.before-restore"))), edited);
}

void TestMpvConfManager::externalLockedLinesAreCommentedOut()
{
  QVERIFY(MpvConfigManager::prepare());
  const QByteArray file = read(path("mpv.conf"));
  write(path("mpv.conf"), file + "vo=gpu\nhwdec=no\n");
  QVERIFY(MpvConfigManager::prepare());
  const QString rewritten = QString::fromUtf8(read(path("mpv.conf")));
  QVERIFY(rewritten.contains("#[已忽略:软件管理] vo=gpu\n"));
  QVERIFY(rewritten.contains("#[已忽略:由「视频」设置页决定] hwdec=no\n"));
  bool noticed = false;
  for (const QVariant& notice : MpvConfigManager::notices())
    noticed = noticed || notice.toMap().value("kind") == QStringLiteral("ignored");
  QVERIFY(noticed);
  QVERIFY(MpvConfigManager::restoreDefault().ok);
}

void TestMpvConfManager::rifeSuspendsConflictingLinesAtStartup()
{
  QVERIFY(MpvConfigManager::prepare());
  QVERIFY(MpvConfigManager::saveUser(MpvConf::appendLines(user(), "default",
      {"# 改帧率", "vf-append=@user-1:fps=60"})).ok);
  SettingsComponent::Get().setValue(SETTINGS_SECTION_VIDEO, "aiRife", true);
  QVERIFY(MpvConfigManager::prepare());
  QVERIFY2(user().contains("#[暂停执行:RIFE] vf-append=@user-1:fps=60\n"), qPrintable(user().right(300)));
  QVERIFY(!QString::fromUtf8(read(path("mpv.conf"))).contains("\ninput-ipc-server="));
  SettingsComponent::Get().setValue(SETTINGS_SECTION_VIDEO, "aiRife", false);
  const MpvConfigManager::WriteResult restored = MpvConfigManager::refresh();
  QCOMPARE(restored.restored.size(), 1);
  QVERIFY(user().contains("\nvf-append=@user-1:fps=60\n"));
  QVERIFY(MpvConfigManager::restoreDefault().ok);
}

void TestMpvConfManager::startupProfileFallsBackToDefault()
{
  SettingsComponent::Get().setValue(SETTINGS_SECTION_MPV, "shaderPreset", "tigerest-user-gone");
  QVERIFY(MpvConfigManager::prepare());
  QVERIFY(QString::fromUtf8(read(path("mpv.conf"))).contains("\nprofile=tigerest-default\n"));
  QVERIFY(MpvConfigManager::saveUser(user() + "[tigerest-user-gone]\nprofile-desc=回来了\nprofile=tigerest-default\n").ok);
  QVERIFY(QString::fromUtf8(read(path("mpv.conf"))).contains("\nprofile=tigerest-user-gone\n"));
  QVERIFY(MpvConfigManager::restoreDefault().ok);
}

void TestMpvConfManager::shaderLibraryKeepsUserFiles()
{
  QVERIFY(MpvConfigManager::prepare());
  const QByteArray bundled = read(QStringLiteral(SOURCE_ROOT "/resources/mpv/shaders/Anime4K/Anime4K_Clamp_Highlights.glsl"));
  QVERIFY(!bundled.isEmpty());
  // An unchanged root copy from a pre-2.9.4 bundle goes; an edited one stays.
  write(path("shaders/Anime4K_Clamp_Highlights.glsl"), bundled);
  // Windows builds of those bundles shipped the same file with CRLF.
  QByteArray crlf = read(QStringLiteral(SOURCE_ROOT "/resources/mpv/shaders/Anime4K/Anime4K_Darken_HQ.glsl"));
  QVERIFY(!crlf.contains('\r'));
  crlf.replace("\n", "\r\n");
  write(path("shaders/Anime4K_Darken_HQ.glsl"), crlf);
  write(path("shaders/Anime4K_Thin_HQ.glsl"), "// edited by the user\n");
  write(path("shaders/user/mine.glsl"), "// mine\n");
  QVERIFY(MpvConfigManager::prepare());
  QVERIFY(!QFile::exists(path("shaders/Anime4K_Clamp_Highlights.glsl")));
  QVERIFY(!QFile::exists(path("shaders/Anime4K_Darken_HQ.glsl")));
  QVERIFY(QFile::exists(path("shaders/Anime4K_Thin_HQ.glsl")));
  QCOMPARE(read(path("shaders/user/mine.glsl")), QByteArray("// mine\n"));
  QVERIFY(QFile::exists(path("shaders/user/说明.txt")));
  QVERIFY(QString::fromUtf8(read(MpvConfigManager::aiGuidePath())).contains("~~/shaders/user/mine.glsl"));
}

void TestMpvConfManager::reportsMissingShaders()
{
  QVERIFY(MpvConfigManager::prepare());
  QVERIFY(MpvConfigManager::saveUser(user() + "[tigerest-user-x]\nglsl-shader=~~/shaders/user/gone.glsl\n").ok);
  // The test resources do not ship the bundled shader files, so look only
  // for the reference this test added.
  const auto missingGone = [] {
    for (const QVariant& entry : MpvConfigManager::missingShaders())
      if (entry.toMap().value("path").toString() == QStringLiteral("~~/shaders/user/gone.glsl"))
        return true;
    return false;
  };
  QVERIFY(missingGone());
  QVERIFY(MpvConfigManager::restoreDefault().ok);
  QVERIFY(!missingGone());
}

void TestMpvConfManager::subtitleFontCoversChinese()
{
#if defined(Q_OS_WIN)
  const QString cjk = QStringLiteral("Microsoft YaHei");
#elif defined(Q_OS_MAC)
  const QString cjk = QStringLiteral("Hiragino Sans GB");
#else
  QSKIP("Other desktops keep the reference Segoe UI default");
#endif
#if defined(Q_OS_WIN) || defined(Q_OS_MAC)
  auto& settings = SettingsComponent::Get();
  // The danmaku file is written in text mode, so CRLF on Windows.
  const auto text = [this](const QString& name) {
    return QString::fromUtf8(read(path(name))).replace(QStringLiteral("\r\n"), QStringLiteral("\n"));
  };
  QCOMPARE(settings.getSection(SETTINGS_SECTION_SUBTITLES)->defaultValue("font").toString(), cjk);

  // A profile from 2.9.5 or earlier stored the former Segoe UI default.
  settings.setValue(SETTINGS_SECTION_SUBTITLES, "font", "Segoe UI");
  settings.setValue(SETTINGS_SECTION_SUBTITLES, "cjkFontMigrated", false);
  QVERIFY(MpvConfigManager::prepare());
  QCOMPARE(settings.value(SETTINGS_SECTION_SUBTITLES, "font").toString(), cjk);
  QVERIFY(text("mpv.conf").contains("\nsub-font=" + cjk + "\n"));
  // Bold stands in for the Yu Gothic UI Semibold look the user preferred.
  QVERIFY(settings.getSection(SETTINGS_SECTION_SUBTITLES)->defaultValue("bold").toBool());
  QVERIFY(text("mpv.conf").contains("\nsub-bold=yes\n"));
  QVERIFY(text("script-opts/uosc_danmaku.conf").contains("\nfontname=" + cjk + "\n"));

  // Choosing Segoe UI again after the move is deliberate and stays.
  settings.setValue(SETTINGS_SECTION_SUBTITLES, "font", "Segoe UI");
  QVERIFY(MpvConfigManager::prepare());
  QCOMPARE(settings.value(SETTINGS_SECTION_SUBTITLES, "font").toString(), QStringLiteral("Segoe UI"));
  QVERIFY(text("mpv.conf").contains("\nsub-font=Segoe UI\n"));

  // Any other font is never part of the move.
  settings.setValue(SETTINGS_SECTION_SUBTITLES, "font", "LXGW WenKai");
  settings.setValue(SETTINGS_SECTION_SUBTITLES, "cjkFontMigrated", false);
  QVERIFY(MpvConfigManager::prepare());
  QCOMPARE(settings.value(SETTINGS_SECTION_SUBTITLES, "font").toString(), QStringLiteral("LXGW WenKai"));
  settings.setValue(SETTINGS_SECTION_SUBTITLES, "font", cjk);
#endif
}

void TestMpvConfManager::editorReplacesAProfilesShaderChain()
{
  const QString user = QStringLiteral(
      "deband=yes\n"
      "\n"
      "[tigerest-default]\n"
      "scale=ewa_lanczos\n"
      "glsl-shaders=\n"
      "# first\n"
      "glsl-shader=~~/shaders/a.glsl\n"
      "glsl-shader=~~/shaders/b.glsl\n"
      "\n"
      "# 自定义档位：mine\n"
      "[tigerest-user-mine]\n"
      "profile=tigerest-default\n"
      "glsl-shaders-append=~~/shaders/c.glsl\n");
  QVariantMap result = MpvConfEditor::edit(user, {{"type", "replaceShaders"}, {"section", "tigerest-default"},
      {"paths", QStringList{"x/one.glsl", "two.glsl"}}, {"titles", QStringList{"One", QString()}}});
  QVERIFY2(!result.contains("error"), qPrintable(result.value("error").toString()));
  QCOMPARE(result.value("user").toString(), QStringLiteral(
      "deband=yes\n"
      "\n"
      "[tigerest-default]\n"
      "scale=ewa_lanczos\n"
      "# 清空继承来的着色器，下面按顺序重新挂载。\n"
      "glsl-shaders=\n"
      "# One\n"
      "glsl-shader=~~/shaders/x/one.glsl\n"
      "glsl-shader=~~/shaders/two.glsl\n"
      "\n"
      "# 自定义档位：mine\n"
      "[tigerest-user-mine]\n"
      "profile=tigerest-default\n"
      "glsl-shaders-append=~~/shaders/c.glsl\n"));

  // An empty chain still drops what the profile inherits, and saving twice leaves one chain.
  result = MpvConfEditor::edit(result.value("user").toString(), {{"type", "replaceShaders"},
      {"section", "tigerest-user-mine"}, {"paths", QStringList{}}});
  const QString twice = MpvConfEditor::edit(result.value("user").toString(), {{"type", "replaceShaders"},
      {"section", "tigerest-user-mine"}, {"paths", QStringList{}}}).value("user").toString();
  QCOMPARE(twice, result.value("user").toString());
  QVERIFY(twice.endsWith(QStringLiteral("profile=tigerest-default\n# 清空继承来的着色器，下面按顺序重新挂载。\nglsl-shaders=\n")));
  QVERIFY(twice.contains(QStringLiteral("glsl-shader=~~/shaders/two.glsl\n")));

  QVERIFY(MpvConfEditor::edit(user, {{"type", "replaceShaders"}, {"section", "default"}, {"paths", QStringList{}}}).contains("error"));
  QVERIFY(MpvConfEditor::edit(user, {{"type", "replaceShaders"}, {"section", "no-such"}, {"paths", QStringList{}}}).contains("error"));
  QVERIFY(MpvConfEditor::edit(user, {{"type", "replaceShaders"}, {"section", "tigerest-default"},
      {"paths", QStringList{"../outside.glsl"}}}).contains("error"));
}

void TestMpvConfManager::editorDeletesOnlyProfilesMadeHere()
{
  const QString user = QStringLiteral(
      "deband=yes\n"
      "\n"
      "# 默认档位\n"
      "[tigerest-default]\n"
      "scale=ewa_lanczos\n"
      "\n"
      "# 自定义档位：first\n"
      "[tigerest-user-first]\n"
      "profile-desc=first\n"
      "profile=tigerest-default\n"
      "saturation=9\n"
      "\n"
      "# 自定义档位：second\n"
      "[tigerest-user-second]\n"
      "profile-desc=second\n"
      "profile=tigerest-user-first\n");
  QVERIFY(MpvConfEditor::edit(user, {{"type", "deleteProfile"}, {"name", "tigerest-default"}}).contains("error"));
  QVERIFY(MpvConfEditor::edit(user, {{"type", "deleteProfile"}, {"name", "tigerest-user-none"}}).contains("error"));
  const QVariantMap needed = MpvConfEditor::edit(user, {{"type", "deleteProfile"}, {"name", "tigerest-user-first"}});
  QVERIFY2(needed.value("error").toString().contains(QStringLiteral("tigerest-user-second")), "a profile another builds on stays");

  const QString withoutSecond = MpvConfEditor::edit(user, {{"type", "deleteProfile"}, {"name", "tigerest-user-second"}}).value("user").toString();
  QCOMPARE(withoutSecond, QStringLiteral(
      "deband=yes\n"
      "\n"
      "# 默认档位\n"
      "[tigerest-default]\n"
      "scale=ewa_lanczos\n"
      "\n"
      "# 自定义档位：first\n"
      "[tigerest-user-first]\n"
      "profile-desc=first\n"
      "profile=tigerest-default\n"
      "saturation=9\n"));
  // In the middle of the file: the next profile keeps the comment that introduces it.
  const QString independent = QString(user).replace(QStringLiteral("profile=tigerest-user-first"), QStringLiteral("profile=tigerest-default"));
  QCOMPARE(MpvConfEditor::edit(independent, {{"type", "deleteProfile"}, {"name", "tigerest-user-first"}}).value("user").toString(),
      QStringLiteral(
      "deband=yes\n"
      "\n"
      "# 默认档位\n"
      "[tigerest-default]\n"
      "scale=ewa_lanczos\n"
      "\n"
      "# 自定义档位：second\n"
      "[tigerest-user-second]\n"
      "profile-desc=second\n"
      "profile=tigerest-default\n"));
}

void TestMpvConfManager::keymapKeepsUserBindings()
{
  QVERIFY(MpvConfigManager::prepare());
  QVERIFY(MpvConfigManager::saveUserKeymap(QString()).value(QStringLiteral("ok")).toBool());
  const QString path = MpvConfigManager::inputConfPath();
  QVERIFY(QFile::exists(path));
  const QString generated = QString::fromUtf8(read(path));
  QVERIFY(generated.contains(MpvConfigManager::defaultKeymap().trimmed()));
  QVERIFY(generated.contains(QStringLiteral("你的自定义")));
  QCOMPARE(MpvConfigManager::userKeymap(), QString());
  QVERIFY(!MpvConfigManager::userKeymapHasBinding(QStringLiteral("F5")));

  QString error;
  const QVariantMap saved = MpvConfigManager::saveUserKeymap(
      QStringLiteral("# 我的快捷键\nF5 seek 10\nESC cycle pause\n"), &error);
  QVERIFY2(saved.value(QStringLiteral("ok")).toBool(), qPrintable(error));
  QVERIFY(MpvConfigManager::userKeymapHasBinding(QStringLiteral("F5")));
  QVERIFY(MpvConfigManager::userKeymapHasBinding(QStringLiteral("ESC")));
  QVERIFY(!MpvConfigManager::userKeymapHasBinding(QStringLiteral("SPACE")));

  // A restart keeps the user block and comments out the default of a key the
  // user rebound, so both spellings never fight over one key.
  QVERIFY(MpvConfigManager::prepare());
  const QString restarted = QString::fromUtf8(read(path));
  QVERIFY(restarted.contains(QStringLiteral("F5 seek 10")));
  QVERIFY(restarted.contains(QStringLiteral("# 已由你的自定义覆盖：ESC stop")));
  QVERIFY(restarted.contains(QStringLiteral("\nSPACE cycle pause\n")));
  QVERIFY(MpvConfigManager::userKeymapHasBinding(QStringLiteral("ESC")));
  QCOMPARE(MpvConfigManager::userKeymap(), QStringLiteral("# 我的快捷键\nF5 seek 10\nESC cycle pause\n"));

  QVERIFY(MpvConfigManager::saveUserKeymap(QString()).value(QStringLiteral("ok")).toBool());
  QCOMPARE(MpvConfigManager::userKeymap(), QString());
  QVERIFY(!MpvConfigManager::userKeymapHasBinding(QStringLiteral("ESC")));
  QVERIFY(QString::fromUtf8(read(path)).contains(QStringLiteral("\nESC stop\n")));
}

void TestMpvConfManager::keymapKeepsHandEditedFile()
{
  QVERIFY(MpvConfigManager::prepare());
  // A file without the markers is a hand edit: keep it whole as the user block.
  write(MpvConfigManager::inputConfPath(), "F7 seek 30\n");
  QVERIFY(MpvConfigManager::prepare());
  QCOMPARE(MpvConfigManager::userKeymap(), QStringLiteral("F7 seek 30\n"));
  QVERIFY(MpvConfigManager::userKeymapHasBinding(QStringLiteral("F7")));
  const QString rewritten = QString::fromUtf8(read(MpvConfigManager::inputConfPath()));
  QVERIFY(rewritten.contains(QStringLiteral("F7 seek 30")));
  QVERIFY(rewritten.contains(QStringLiteral("# 已由你的自定义覆盖：")));
  QVERIFY(MpvConfigManager::saveUserKeymap(QString()).value(QStringLiteral("ok")).toBool());
}

QTEST_GUILESS_MAIN(TestMpvConfManager)
#include "test_mpv_conf_manager.moc"
