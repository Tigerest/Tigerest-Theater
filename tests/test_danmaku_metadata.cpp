#include <QtTest/QtTest>

#include <mpv/client.h>

#include <QElapsedTimer>
#include <QFileInfo>
#include <QStringList>

namespace
{

class MpvProbe
{
public:
  explicit MpvProbe(const QString& scriptPath)
  {
    m_handle = mpv_create();
    if (!m_handle)
      return;

    const QByteArray script = QFileInfo(scriptPath).absoluteFilePath().toUtf8();
    if (mpv_set_option_string(m_handle, "config", "no") < 0
        || mpv_set_option_string(m_handle, "terminal", "no") < 0
        || mpv_set_option_string(m_handle, "vo", "null") < 0
        || mpv_set_option_string(m_handle, "ao", "null") < 0
        || mpv_set_option_string(m_handle, "load-scripts", "no") < 0
        || mpv_set_option_string(m_handle, "scripts", script.constData()) < 0
        || mpv_initialize(m_handle) < 0)
    {
      mpv_terminate_destroy(m_handle);
      m_handle = nullptr;
    }
    else
    {
      mpv_request_log_messages(m_handle, "debug");
    }
  }

  ~MpvProbe()
  {
    if (m_handle)
      mpv_terminate_destroy(m_handle);
  }

  bool isValid() const { return m_handle != nullptr; }

  bool setString(const char* property, const QString& value)
  {
    const QByteArray utf8 = value.toUtf8();
    return mpv_set_property_string(m_handle, property, utf8.constData()) >= 0;
  }

  bool setFlag(const char* property, bool value)
  {
    int flag = value ? 1 : 0;
    return mpv_set_property(m_handle, property, MPV_FORMAT_FLAG, &flag) >= 0;
  }

  QString getString(const char* property) const
  {
    mpv_node value{};
    if (mpv_get_property(m_handle, property, MPV_FORMAT_NODE, &value) < 0)
      return {};
    const QString result = value.format == MPV_FORMAT_STRING && value.u.string
      ? QString::fromUtf8(value.u.string)
      : QString();
    mpv_free_node_contents(&value);
    return result;
  }

  bool getFlag(const char* property) const
  {
    int value = 0;
    return mpv_get_property(m_handle, property, MPV_FORMAT_FLAG, &value) >= 0 && value;
  }

  bool probe(const char* message = "tigerest-danmaku-probe")
  {
    if (!setFlag("user-data/tigerest-test/done", false))
      return false;
    const char* command[] = {"script-message", message, nullptr};
    if (mpv_command(m_handle, command) < 0)
      return false;

    QElapsedTimer timer;
    timer.start();
    while (timer.elapsed() < 3000)
    {
      mpv_event* event = mpv_wait_event(m_handle, 0.01);
      if (event->event_id == MPV_EVENT_LOG_MESSAGE)
      {
        const auto* log = static_cast<mpv_event_log_message*>(event->data);
        m_logs << QStringLiteral("[%1] %2")
                    .arg(QString::fromUtf8(log->prefix), QString::fromUtf8(log->text).trimmed());
      }
      int done = 0;
      if (mpv_get_property(m_handle, "user-data/tigerest-test/done",
                           MPV_FORMAT_FLAG, &done) >= 0 && done)
        return true;
    }
    qWarning().noquote() << m_logs.join(QLatin1Char('\n'));
    return false;
  }

private:
  mpv_handle* m_handle = nullptr;
  QStringList m_logs;
};

}

class TestDanmakuMetadata : public QObject
{
  Q_OBJECT

private slots:
  void structuredEmbyMetadataTakesPriority();
  void enabledStreamRequiresInitializationWithoutLocalDirectory();
};

void TestDanmakuMetadata::structuredEmbyMetadataTakesPriority()
{
  const QString sourceRoot = QStringLiteral(SOURCE_ROOT);
  const QString script = sourceRoot + QStringLiteral("/tests/fixtures/tigerest_danmaku_metadata_probe.lua");
  const QString pluginRoot = sourceRoot + QStringLiteral("/resources/mpv/plugins/uosc_danmaku");
  QVERIFY2(QFileInfo::exists(script), "Lua probe fixture was not found");
  QVERIFY2(QFileInfo::exists(pluginRoot), "Bundled uosc_danmaku root was not found");

  MpvProbe probe(script);
  QVERIFY2(probe.isValid(), "Unable to initialize the headless libmpv probe");
  QVERIFY(probe.setFlag("user-data/tigerest/emby/valid", true));
  QVERIFY(probe.setString("user-data/tigerest/emby/series-name", QStringLiteral("葬送的芙莉莲")));
  QVERIFY(probe.setString("user-data/tigerest/emby/season-number", QStringLiteral("1")));
  QVERIFY(probe.setString("user-data/tigerest/emby/episode-number", QStringLiteral("3")));

  QVERIFY2(probe.probe(), "Lua metadata probe did not answer");
  QCOMPARE(probe.getString("user-data/tigerest-test/title"), QStringLiteral("葬送的芙莉莲"));
  QCOMPARE(probe.getString("user-data/tigerest-test/season"), QStringLiteral("1"));
  QCOMPARE(probe.getString("user-data/tigerest-test/episode"), QStringLiteral("3"));
}

void TestDanmakuMetadata::enabledStreamRequiresInitializationWithoutLocalDirectory()
{
  const QString sourceRoot = QStringLiteral(SOURCE_ROOT);
  const QString script = sourceRoot + QStringLiteral("/tests/fixtures/tigerest_danmaku_metadata_probe.lua");

  MpvProbe probe(script);
  QVERIFY2(probe.isValid(), "Unable to initialize the headless libmpv probe");
  QVERIFY2(probe.probe("tigerest-danmaku-autoload-probe"),
           "Lua stream autoload probe did not answer");
  QVERIFY(probe.getFlag("user-data/tigerest-test/should-init-stream"));
}

QTEST_GUILESS_MAIN(TestDanmakuMetadata)

#include "test_danmaku_metadata.moc"
