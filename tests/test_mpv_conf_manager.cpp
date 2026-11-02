#include <QtTest/QtTest>

#include "Paths.h"
#include "core/ProfileManager.h"
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

QTEST_GUILESS_MAIN(TestMpvConfManager)
#include "test_mpv_conf_manager.moc"
