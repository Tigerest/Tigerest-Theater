// The Mac's Apple-native interpolation policy: the filter a setting gives,
// the hardware decoding it needs, and what the viewer is told.
#include "NativeInterpolationPolicy.h"
#include <QtTest>

class TestNativeInterpolationPolicy : public QObject
{
  Q_OBJECT
private slots:
  void filters()
  {
    using native::Mode;
    QCOMPARE(native::modeFromSetting(QStringLiteral("quality")), Mode::Quality);
    QCOMPARE(native::modeFromSetting(QStringLiteral("efficient")), Mode::Efficient);
    QCOMPARE(native::modeFromSetting(QStringLiteral("whatever")), Mode::Off);
    QVERIFY(native::filterText(Mode::Off, QStringLiteral("2x"), 120).isEmpty());
    QCOMPARE(native::filterText(Mode::Quality, QStringLiteral("2x"), 120),
             QStringLiteral("@tigerest-vtfi:tigerest-vtfi=mode=quality:factor=2"));
    QCOMPARE(native::filterText(Mode::Efficient, QStringLiteral("60"), 60),
             QStringLiteral("@tigerest-vtfi:tigerest-vtfi=mode=efficient:target=60"));
    QCOMPARE(native::filterText(Mode::Quality, QStringLiteral("display"), 119.88),
             QStringLiteral("@tigerest-vtfi:tigerest-vtfi=mode=quality:target=120"));
    // An unknown or slow screen falls back to twice the source rate.
    QCOMPARE(native::filterText(Mode::Quality, QStringLiteral("display"), 0),
             QStringLiteral("@tigerest-vtfi:tigerest-vtfi=mode=quality:factor=2"));
    QCOMPARE(native::filterText(Mode::Quality, QStringLiteral("display"), 24),
             QStringLiteral("@tigerest-vtfi:tigerest-vtfi=mode=quality:factor=2"));
  }

  void decoding()
  {
    QCOMPARE(native::hardwareDecoding(QStringLiteral("auto-copy")), QStringLiteral("auto"));
    QCOMPARE(native::hardwareDecoding(QStringLiteral("videotoolbox-copy")), QStringLiteral("auto"));
    QVERIFY(native::hardwareDecoding(QStringLiteral("auto")).isEmpty());
    QVERIFY(native::hardwareDecoding(QStringLiteral("auto-safe")).isEmpty());
    // Deliberate software decoding stays.
    QVERIFY(native::hardwareDecoding(QStringLiteral("no")).isEmpty());
  }

  void notices()
  {
    for (const char* quiet : {"active", "preparing", "warming", "waiting", "target-not-higher", ""})
      QVERIFY2(native::notice(QString::fromLatin1(quiet)).isEmpty(), quiet);
    for (const char* told : {"unsupported-size", "unsupported-fps", "hdr", "interlaced", "needs-hardware-frames",
                             "unavailable", "too-slow", "failed", "fallback-efficient"})
      QVERIFY2(!native::notice(QString::fromLatin1(told)).isEmpty(), told);
  }

  void diagnostics()
  {
    QCOMPARE(native::diagnostics({}, {}).value(QStringLiteral("active")).toBool(), false);
    const QVariantMap metadata{{QStringLiteral("status"), QStringLiteral("active")}, {QStringLiteral("mode"), QStringLiteral("quality")},
                               {QStringLiteral("sourceFps"), QStringLiteral("23.976024")}, {QStringLiteral("outputFps"), QStringLiteral("47.952048")},
                               {QStringLiteral("generated"), QStringLiteral("120")}, {QStringLiteral("processP95Ms"), QStringLiteral("24.5")},
                               {QStringLiteral("fallback"), QStringLiteral("efficient")}};
    const QVariantMap state = native::diagnostics(metadata, QStringLiteral("@tigerest-vtfi:tigerest-vtfi=mode=quality:factor=2"));
    QCOMPARE(state.value(QStringLiteral("status")).toString(), QStringLiteral("active"));
    QCOMPARE(state.value(QStringLiteral("generated")).toLongLong(), 120);
    QVERIFY(qAbs(state.value(QStringLiteral("outputFps")).toDouble() - 47.952048) < 1e-6);
    QVERIFY(qAbs(state.value(QStringLiteral("processP95Ms")).toDouble() - 24.5) < 1e-9);
    QVERIFY(state.value(QStringLiteral("fellBack")).toBool());
  }
};

QTEST_GUILESS_MAIN(TestNativeInterpolationPolicy)
#include "test_native_interpolation_policy.moc"
