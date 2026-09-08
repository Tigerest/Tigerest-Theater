#import <AppKit/AppKit.h>

#include <QtTest/QtTest>
#include <QQuickWindow>
#include <QTemporaryDir>
#include <QScopeGuard>
#include <MpvController>
#include "player/MpvVideoItem.h"
#include "settings/SettingsComponent.h"
#include "settings/SettingsSection.h"

class TestMacosPause : public QObject
{
  Q_OBJECT
private slots:
  void nativeWindowPause_data();
  void nativeWindowPause();
};

void TestMacosPause::nativeWindowPause_data()
{
  QTest::addColumn<bool>("uosc");
  QTest::newRow("native") << false;
  QTest::newRow("native-with-uosc") << true;
}

void TestMacosPause::nativeWindowPause()
{
  QFETCH(bool, uosc);
  QTemporaryDir config;
  QVERIFY(config.isValid());
  QFile conf(config.filePath("mpv.conf"));
  QVERIFY(conf.open(QIODevice::WriteOnly));
  conf.write("vo=null\nao=null\nosc=no\nload-scripts=no\ninput-default-bindings=yes\n");
  if (uosc)
    conf.write("script=\"" SOURCE_ROOT "/resources/mpv/plugins/uosc.lua\"\n");
  conf.close();
  if (uosc) {
    QVERIFY(QDir(config.path()).mkdir("script-opts"));
    QVERIFY(QFile::copy(QStringLiteral(SOURCE_ROOT "/resources/mpv/script-opts/uosc.conf"),
                       config.filePath("script-opts/uosc.conf")));
  }
  QVERIFY(QFile::copy(QStringLiteral(SOURCE_ROOT "/resources/mpv/input.conf"),
                     config.filePath("input.conf")));
  qputenv("TIGEREST_MPV_CONFIG_DIR", config.path().toUtf8());
  qunsetenv("TIGEREST_MPV_INCLUDE");
  qunsetenv("TIGEREST_MPV_SAFE_SCRIPTS");

  auto* section = new SettingsSection("mpv", PLATFORM_ANY, -1, &SettingsComponent::Get());
  section->registerSetting(new SettingsValue("renderBackend", "gpu-next"));
  SettingsComponent::Get().registerSection(section);
  MpvVideoItem item;
  const auto stopBeforeDestroy = qScopeGuard([&]() {
    item.commandAsync({"stop"});
    QTest::qWait(500);
  });
  QVERIFY(item.usingNativeGpuNext());
  item.setPropertyBlocking("vo", "gpu-next");
  item.setPropertyBlocking("gpu-api", "vulkan");
  item.setPropertyBlocking("gpu-context", "macvk");
  item.setPropertyBlocking("input-vo-keyboard", true);
  item.setPropertyBlocking("input-cursor", true);
  item.setPropertyBlocking("loop-file", "inf");
  item.setPropertyBlocking("fullscreen", false);
  QSignalSpy loaded(item.controller(), &MpvController::fileLoaded);
  item.commandAsync({"loadfile", QStringLiteral(SOURCE_ROOT "/resources/testmedia/high_1920x1080.h264")});
  QTRY_VERIFY_WITH_TIMEOUT(loaded.count() > 0, 15000);

  NSWindow* native = nil;
  for (NSWindow* candidate in NSApp.windows) {
    qInfo() << "Native window:" << QString::fromNSString(NSStringFromClass(candidate.class))
            << QString::fromNSString(NSStringFromClass(candidate.contentView.class));
    if (candidate.visible && [NSStringFromClass(candidate.class) hasSuffix:@".Window"])
      native = candidate;
  }
  QVERIFY(native != nil);
  [native makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
  auto key = [&](NSEventType type, bool repeat = false, NSEventModifierFlags modifiers = 0,
                 NSWindow* target = nil) {
    NSWindow* window = target ?: native;
    NSEvent* event = [NSEvent keyEventWithType:type location:NSZeroPoint modifierFlags:modifiers
        timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber
        context:nil characters:@" " charactersIgnoringModifiers:@" " isARepeat:repeat keyCode:49];
    [NSApp postEvent:event atStart:NO];
    QTest::qWait(100);
  };
  auto click = [&](NSEventType type, NSInteger count) {
    NSEvent* event = [NSEvent mouseEventWithType:type location:NSMakePoint(100, 100)
        modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime
        windowNumber:native.windowNumber context:nil eventNumber:0 clickCount:count pressure:1];
    [NSApp postEvent:event atStart:NO];
    QTest::qWait(30);
  };
  auto paused = [&]() { return item.getProperty("pause").toBool(); };
  QVERIFY(!paused());
  key(NSEventTypeKeyDown);
  QVERIFY2(paused(), "Space in the native macvk window must pause playback");
  key(NSEventTypeKeyDown, true);
  key(NSEventTypeKeyUp);
  QVERIFY2(paused(), "Key repeats and release must not toggle pause a second time");
  key(NSEventTypeKeyDown);
  key(NSEventTypeKeyUp);
  QVERIFY(!paused());

  click(NSEventTypeLeftMouseDown, 1);
  click(NSEventTypeLeftMouseUp, 1);
  click(NSEventTypeLeftMouseDown, 2);
  click(NSEventTypeLeftMouseUp, 2);
  QTest::qWait(350);
  QVERIFY2(paused(), "One native double-click must toggle pause exactly once");
  item.setPropertyBlocking("pause", false);

  key(NSEventTypeKeyDown, false, NSEventModifierFlagCommand);
  key(NSEventTypeKeyUp, false, NSEventModifierFlagCommand);
  QVERIFY2(!paused(), "Modified Space must retain its original behavior");
  QQuickWindow library;
  library.show();
  NSWindow* qtWindow = [reinterpret_cast<NSView*>(library.winId()) window];
  key(NSEventTypeKeyDown, false, 0, qtWindow);
  key(NSEventTypeKeyUp, false, 0, qtWindow);
  QVERIFY2(!paused(), "Space in the Qt library must not control the native player");
  item.setVisible(false);
  key(NSEventTypeKeyDown);
  key(NSEventTypeKeyUp);
  QVERIFY2(!paused(), "Hidden playback must not consume input");
  item.commandAsync({"stop"});
  QTest::qWait(300);
}

int main(int argc, char** argv)
{
  QQuickWindow::setGraphicsApi(QSGRendererInterface::OpenGL);
  QGuiApplication app(argc, argv);
  TestMacosPause test;
  return QTest::qExec(&test, argc, argv);
}

#include "test_macos_pause.moc"
