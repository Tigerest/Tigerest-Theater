#include <QtTest/QtTest>
#include <MpvAbstractItem>
#include <MpvController>
#include <QGuiApplication>
#include <QQuickWindow>
#include <QTemporaryDir>
#include <QScopeGuard>
#include <thread>
#include "Paths.h"
#include "core/ProfileManager.h"
#include "settings/SettingsComponent.h"
#if defined(Q_OS_WIN)
#include <qt_windows.h>
#endif
#include "../src/player/PlayerComponent.h"
#include "../src/display/DisplayComponent.h"

#define private public
#include "../src/ui/WindowManager.h"
#include "../src/player/MpvVideoItem.h"
#undef private

namespace
{
void clearOverrideCursor()
{
  while (QGuiApplication::overrideCursor())
    QGuiApplication::restoreOverrideCursor();
}

#if defined(Q_OS_WIN)
// Stands for mpv's renderer window below the native host.
int g_rendererDisplayChanges = 0;
LRESULT CALLBACK rendererFixtureProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam)
{
  if (message == WM_DISPLAYCHANGE)
    ++g_rendererDisplayChanges;
  return DefWindowProcW(window, message, wParam, lParam);
}
#endif
}

class TestWindowManager : public QObject
{
  Q_OBJECT
  QTemporaryDir fixture;

private slots:
  void initTestCase();
  void cleanup();
  void testStartupFullscreenPreference_data();
  void testStartupFullscreenPreference();
  void testMovingToAnotherScreenRefreshesPlaybackPolicy();
  void testFullscreenStateIsIndependentFromRestoreVisibility();
  void testPlaybackSessionRestoresMaximizedWindow();
  void testPlaybackSessionPreservesPreexistingFullscreen();
  void testPlaybackFullscreenTargetsVideoWindow_data();
  void testPlaybackFullscreenTargetsVideoWindow();
  void testNativePlaybackLeavesCursorAutohideToMpv();
  void testEndingNativePlaybackRestoresWebCursorControl();
#if defined(Q_OS_WIN)
  void testCustomChromeKeepsNativeSnapAndRestore_data();
  void testCustomChromeKeepsNativeSnapAndRestore();
  void testWindowsEdgeDragSnap_data();
  void testWindowsEdgeDragSnap();
  void testForcedFullscreenScreen_data();
  void testForcedFullscreenScreen();
  void testScreenChangeTellsNativeRenderer();
  void testPlaybackInheritsHostFullscreen_data();
  void testPlaybackInheritsHostFullscreen();
  void testNativeVideoAnchorDoesNotPaintOverScene();
  void testNativeHostTracksMainWindowLifecycle();
  void testNativePlaybackHidesActualWindowsCursor();
  void testNativePlaybackNormalizesActualWindowsCursor_data();
  void testNativePlaybackNormalizesActualWindowsCursor();
  void testNativeFullscreenKeepsWindowsComposition_data();
  void testNativeFullscreenKeepsWindowsComposition();
#endif
};

void TestWindowManager::initTestCase()
{
  QVERIFY(fixture.isValid());
  Paths::setConfigDir(fixture.path());
  Paths::setCacheDir(fixture.filePath("cache"));
  ProfileManager::Get().setActiveProfile(ProfileManager::createProfile("Window lifecycle fixture"));
  QVERIFY(SettingsComponent::Get().componentInitialize());
}

void TestWindowManager::cleanup()
{
  PlayerComponent::Get().setWindow(nullptr);
  DisplayComponent::Get().setApplicationWindow(nullptr);
  PlayerComponent::Get().setNativeVideoOutput(false);
  clearOverrideCursor();
}

void TestWindowManager::testStartupFullscreenPreference_data()
{
  QTest::addColumn<bool>("startupFullscreen");
  QTest::addColumn<bool>("staleRuntimeFullscreen");
  QTest::newRow("windowed-ignores-last-fullscreen") << false << true;
  QTest::newRow("fullscreen-ignores-last-windowed") << true << false;
}

void TestWindowManager::testStartupFullscreenPreference()
{
  QFETCH(bool, startupFullscreen);
  QFETCH(bool, staleRuntimeFullscreen);
  auto& settings = SettingsComponent::Get();
  settings.setValue("home", "startupFullscreen", startupFullscreen);
  settings.setValue("main", "fullscreen", staleRuntimeFullscreen);
  QQuickWindow window;
  WindowManager manager;
  manager.m_window = &window;
  connect(&window, SIGNAL(visibilityChanged(QWindow::Visibility)),
          &manager, SLOT(onVisibilityChanged(QWindow::Visibility)));
  QVERIFY(QMetaObject::invokeMethod(&manager, "applySettings", Qt::DirectConnection));
  // A false startup preference leaves the saved windowed/maximized geometry.
  if (!window.isVisible())
    window.show();
  QTRY_COMPARE(manager.isFullScreen(), startupFullscreen);
  manager.setFullScreen(!startupFullscreen);
  QTRY_COMPARE(manager.isFullScreen(), !startupFullscreen);
  QCOMPARE(settings.value("home", "startupFullscreen").toBool(), startupFullscreen);
  settings.setValue("home", "startupFullscreen", !startupFullscreen);
  settings.setValue("home", "startupFullscreen", startupFullscreen);
  QCOMPARE(manager.isFullScreen(), !startupFullscreen);
  window.hide();
}

#if defined(Q_OS_WIN)
void TestWindowManager::testCustomChromeKeepsNativeSnapAndRestore_data()
{
  QTest::addColumn<int>("screenIndex");
  for (int index = 0; index < QGuiApplication::screens().size(); ++index)
    QTest::newRow(qPrintable(QGuiApplication::screens()[index]->name())) << index;
}

void TestWindowManager::testCustomChromeKeepsNativeSnapAndRestore()
{
  QFETCH(int, screenIndex);
  if (QGuiApplication::platformName() != QStringLiteral("windows"))
    QSKIP("Native window styles require the Windows platform plugin");
  QQuickWindow window;
  WindowManager manager;
  window.setProperty("customTitleBarEnabled", true);
  window.setFlags(Qt::Window | Qt::FramelessWindowHint | Qt::WindowSystemMenuHint |
                  Qt::WindowMinMaxButtonsHint | Qt::WindowCloseButtonHint);
  manager.m_window = &window;
  window.installEventFilter(&manager);
  connect(&window, SIGNAL(visibilityChanged(QWindow::Visibility)),
          &manager, SLOT(onVisibilityChanged(QWindow::Visibility)));
  QScreen* screen = QGuiApplication::screens()[screenIndex];
  window.setScreen(screen);
  window.setGeometry(QRect(screen->availableGeometry().center() - QPoint(320, 200), QSize(640, 400)));
  window.showNormal();
  QVERIFY(QTest::qWaitForWindowExposed(&window));
  const HWND handle = reinterpret_cast<HWND>(window.winId());
  const auto requiredStyles = WS_THICKFRAME | WS_CAPTION | WS_MAXIMIZEBOX | WS_MINIMIZEBOX;
  QTRY_VERIFY2((GetWindowLongPtr(handle, GWL_STYLE) & requiredStyles) == requiredStyles,
           "Custom chrome must retain native resize/caption styles for Windows Snap");
  RECT outer{}, client{};
  GetWindowRect(handle, &outer);
  GetClientRect(handle, &client);
  QCOMPARE(client.right, outer.right - outer.left);
  QCOMPARE(client.bottom, outer.bottom - outer.top);
  const QRect normalGeometry = window.geometry();
  for (int cycle = 0; cycle < 3; ++cycle) {
    window.showMaximized();
    QTRY_VERIFY(IsZoomed(handle));
    QTest::qWait(100); // Catch Qt's later native size-based fullscreen detection.
    QTRY_COMPARE(window.visibility(), QWindow::Maximized);
    MONITORINFO monitor{sizeof(MONITORINFO)};
    QVERIFY(GetMonitorInfo(MonitorFromWindow(handle, MONITOR_DEFAULTTONEAREST), &monitor));
    GetClientRect(handle, &client);
    POINT clientOrigin{};
    QVERIFY(ClientToScreen(handle, &clientOrigin));
    const QRect work(monitor.rcWork.left, monitor.rcWork.top,
                     monitor.rcWork.right - monitor.rcWork.left,
                     monitor.rcWork.bottom - monitor.rcWork.top);
    const QRect bounds(clientOrigin.x, clientOrigin.y, client.right, client.bottom);
    QVERIFY(work.contains(bounds));
    // An autohide taskbar may need a one-physical-pixel reveal strip.
    QVERIFY(work.width() - bounds.width() <= 1);
    QVERIFY(work.height() - bounds.height() <= 1);
    manager.setFullScreen(true);
    QTRY_COMPARE(window.visibility(), QWindow::FullScreen);
    manager.setFullScreen(false);
    QTRY_COMPARE(window.visibility(), QWindow::Maximized);
    QTRY_VERIFY(IsZoomed(handle));
    window.showNormal();
    QTRY_COMPARE(window.geometry(), normalGeometry);
    manager.setAlwaysOnTop(true);
    manager.setAlwaysOnTop(false);
    QTest::qWait(100); // Let queued native state/geometry notifications settle.
    QCOMPARE(window.visibility(), QWindow::Windowed);
    QVERIFY((GetWindowLongPtr(handle, GWL_STYLE) & requiredStyles) == requiredStyles);
  }
  window.hide();
}

void TestWindowManager::testWindowsEdgeDragSnap_data()
{
  QTest::addColumn<bool>("customChrome");
  QTest::newRow("standard-frame-control") << false;
  QTest::newRow("custom-chrome") << true;
}

void TestWindowManager::testWindowsEdgeDragSnap()
{
  QFETCH(bool, customChrome);
  if (!qEnvironmentVariableIsSet("TIGEREST_TEST_NATIVE_SNAP"))
    QSKIP("Opt in with TIGEREST_TEST_NATIVE_SNAP=1: this test moves the real desktop pointer");
  if (QGuiApplication::platformName() != QStringLiteral("windows"))
    QSKIP("Windows Snap requires the Windows platform plugin");
  BOOL arranging = FALSE;
  QVERIFY(SystemParametersInfo(SPI_GETWINARRANGING, 0, &arranging, 0));
  if (!arranging)
    QSKIP("Windows Snap is disabled in the desktop settings");
  POINT originalCursor{};
  GetCursorPos(&originalCursor);
  const HWND originalForeground = GetForegroundWindow();
  const auto restoreDesktop = qScopeGuard([&]() {
    SetCursorPos(originalCursor.x, originalCursor.y);
    if (IsWindow(originalForeground))
      SetForegroundWindow(originalForeground);
  });
  QQuickWindow window;
  WindowManager manager;
  window.setTitle("Tigerest native Snap fixture");
  window.setProperty("customTitleBarEnabled", customChrome);
  window.setFlags(Qt::Window | Qt::WindowTitleHint | Qt::WindowMinMaxButtonsHint |
                  (customChrome ? Qt::FramelessWindowHint : Qt::WindowFlags{}));
  manager.m_window = &window;
  window.installEventFilter(&manager);
  window.setGeometry(QRect(window.screen()->availableGeometry().center() - QPoint(320, 200), QSize(640, 400)));
  window.show();
  QVERIFY(QTest::qWaitForWindowExposed(&window));
  const HWND handle = reinterpret_cast<HWND>(window.winId());
  QTRY_VERIFY(GetWindowLongPtr(handle, GWL_STYLE) & WS_THICKFRAME);
  // Windows can reject SetForegroundWindow from a background test runner.
  // Activate only this isolated fixture through an actual click, then remove
  // the temporary topmost flag before testing normal desktop Snap behavior.
  SetWindowPos(handle, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
  POINT activation{100, 70};
  ClientToScreen(handle, &activation);
  SetCursorPos(activation.x, activation.y);
  INPUT click[2]{};
  click[0].type = click[1].type = INPUT_MOUSE;
  click[0].mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
  click[1].mi.dwFlags = MOUSEEVENTF_LEFTUP;
  QCOMPARE(SendInput(2, click, sizeof(INPUT)), UINT(2));
  QTRY_COMPARE(GetForegroundWindow(), handle);
  SetWindowPos(handle, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE);
  MONITORINFO monitor{sizeof(MONITORINFO)};
  QVERIFY(GetMonitorInfo(MonitorFromWindow(handle, MONITOR_DEFAULTTONEAREST), &monitor));
  const QSize normalSize = window.size();
  const auto dragTo = [&](POINT target) {
    RECT client{};
    GetClientRect(handle, &client);
    POINT start{client.right / 3, qRound(18 * window.devicePixelRatio())};
    ClientToScreen(handle, &start);
    SetCursorPos(start.x, start.y);
    INPUT down{};
    down.type = INPUT_MOUSE;
    down.mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
    SendInput(1, &down, sizeof(INPUT));
    QTest::qWait(80);
    const bool started = window.startSystemMove();
    std::thread pointer([=]() {
      Sleep(150);
      for (int step = 1; step <= 30; ++step) {
        SetCursorPos(start.x + (target.x - start.x) * step / 30,
                     start.y + (target.y - start.y) * step / 30);
        Sleep(12);
      }
      Sleep(400);
      INPUT up{};
      up.type = INPUT_MOUSE;
      up.mi.dwFlags = MOUSEEVENTF_LEFTUP;
      SendInput(1, &up, sizeof(INPUT));
    });
    QTest::qWait(1200);
    pointer.join();
    qInfo() << "Native drag" << QPoint(start.x, start.y) << "to" << QPoint(target.x, target.y)
            << "result geometry" << window.geometry() << "state" << window.visibility();
    return started;
  };
  const LONG midX = (monitor.rcWork.left + monitor.rcWork.right) / 2;
  const LONG midY = (monitor.rcWork.top + monitor.rcWork.bottom) / 2;
  QVERIFY(dragTo({monitor.rcMonitor.left + (monitor.rcMonitor.right - monitor.rcMonitor.left) / 5,
                  monitor.rcMonitor.top}));
  QTRY_VERIFY(IsZoomed(handle));
  QTRY_COMPARE(window.visibility(), QWindow::Maximized);
  QVERIFY(dragTo({midX, midY}));
  QTRY_VERIFY(!IsZoomed(handle));
  QTRY_COMPARE(window.size(), normalSize);
  if (!customChrome)
    return;
  // Snap targets come from Windows' own monitor work area, in physical pixels.
  const auto clientBounds = [&]() {
    RECT bounds{};
    GetClientRect(handle, &bounds);
    POINT origin{};
    ClientToScreen(handle, &origin);
    return QRect(origin.x, origin.y, bounds.right, bounds.bottom);
  };
  QVERIFY(dragTo({monitor.rcMonitor.left, midY}));
  QTRY_VERIFY(qAbs(clientBounds().left() - monitor.rcWork.left) <= 16);
  QTRY_VERIFY(qAbs(clientBounds().right() + 1 - midX) <= 16);
  QTRY_VERIFY(qAbs(clientBounds().height() - (monitor.rcWork.bottom - monitor.rcWork.top)) <= 16);
  QVERIFY(dragTo({monitor.rcMonitor.right - 1, midY}));
  QTRY_VERIFY(qAbs(clientBounds().left() - midX) <= 16);
  QTRY_VERIFY(qAbs(clientBounds().right() + 1 - monitor.rcWork.right) <= 16);
  // Pull away from the dock threshold before entering the top edge again.
  // Staying within that threshold is just repositioning a snapped window.
  QVERIFY(dragTo({midX, midY}));
  QTRY_COMPARE(window.size(), normalSize);
  // Windows 11 reserves the top-center for its Snap layout picker. Use the
  // top edge outside that picker to exercise the maximize gesture itself.
  QVERIFY(dragTo({monitor.rcMonitor.left + (monitor.rcMonitor.right - monitor.rcMonitor.left) / 5,
                  monitor.rcMonitor.top}));
  QTRY_VERIFY(IsZoomed(handle));
  QTRY_COMPARE(window.visibility(), QWindow::Maximized);
  QVERIFY(dragTo({midX, midY}));
  QTRY_VERIFY(!IsZoomed(handle));
  QTRY_COMPARE(window.visibility(), QWindow::Windowed);
  QTRY_COMPARE(window.size(), normalSize);
  window.hide();
}

void TestWindowManager::testForcedFullscreenScreen_data()
{
  QTest::addColumn<int>("home");
  QTest::addColumn<int>("forced");
  QTest::addColumn<bool>("maximized");
  QTest::addColumn<bool>("changedWhileFullscreen");
  const int count = int(QGuiApplication::screens().size());
  for (int home = 0; home < count && home < 2; ++home) {
    const int forced = (home + 1) % count;
    if (forced == home)
      continue;
    const QString route = QStringLiteral("%1-to-%2").arg(home).arg(forced);
    QTest::newRow(qPrintable(route + "-windowed")) << home << forced << false << false;
    QTest::newRow(qPrintable(route + "-maximized")) << home << forced << true << false;
    QTest::newRow(qPrintable(route + "-chosen-while-fullscreen")) << home << forced << false << true;
  }
}

// 设置 → 指定全屏显示器: fullscreen covers the chosen display (not the one the
// window was on), the playback refresh rate is asked again once the window is
// there, and leaving fullscreen puts the window back where it was.
void TestWindowManager::testForcedFullscreenScreen()
{
  QFETCH(int, home);
  QFETCH(int, forced);
  QFETCH(bool, maximized);
  QFETCH(bool, changedWhileFullscreen);
  if (QGuiApplication::platformName() != QStringLiteral("windows"))
    QSKIP("Fullscreen placement requires the Windows platform plugin");
  const auto screens = QGuiApplication::screens();
  if (screens.size() < 2)
    QSKIP("Needs two displays");
  QScreen* homeScreen = screens[home];
  QScreen* forcedScreen = screens[forced];
  auto& settings = SettingsComponent::Get();
  const auto clearSetting = qScopeGuard([&]() { settings.setValue("main", "forceFSScreen", QString()); });
  settings.setValue("main", "forceFSScreen", changedWhileFullscreen ? QString() : forcedScreen->name());

  QQuickWindow window;
  WindowManager manager;
  manager.m_window = &window;
  manager.m_previousVisibility = maximized ? QWindow::Maximized : QWindow::Windowed;
  manager.m_isFullScreen = false;
  connect(&window, SIGNAL(visibilityChanged(QWindow::Visibility)),
          &manager, SLOT(onVisibilityChanged(QWindow::Visibility)));
  auto& display = DisplayComponent::Get();
  display.setApplicationWindow(&window);
  // Where the window is each time playback asks for the refresh rate again.
  QList<QScreen*> refreshedOn;
  connect(&display, &DisplayComponent::refreshRateChanged, &window, [&]() {
    refreshedOn << QGuiApplication::screenAt(window.geometry().center());
  });

  window.setScreen(homeScreen);
  window.setGeometry(QRect(homeScreen->availableGeometry().center() - QPoint(320, 200), QSize(640, 400)));
  window.showNormal();
  QVERIFY(QTest::qWaitForWindowExposed(&window));
  const QRect normalGeometry = window.geometry();
  if (maximized) {
    window.showMaximized();
    QTRY_COMPARE(window.visibility(), QWindow::Maximized);
  }
  const QRect startGeometry = window.geometry();
  const HWND handle = reinterpret_cast<HWND>(window.winId());
  // The window covers a whole monitor, in Windows' own physical pixels.
  const auto coversMonitor = [&]() {
    MONITORINFO monitor{sizeof(MONITORINFO)};
    RECT rect{};
    return GetMonitorInfo(MonitorFromWindow(handle, MONITOR_DEFAULTTONEAREST), &monitor) &&
           GetWindowRect(handle, &rect) && EqualRect(&rect, &monitor.rcMonitor);
  };

  manager.setFullScreen(true);
  QTRY_COMPARE(window.visibility(), QWindow::FullScreen);
  if (changedWhileFullscreen) {
    QTRY_VERIFY(coversMonitor());
    QCOMPARE(window.geometry(), homeScreen->geometry());
    settings.setValue("main", "forceFSScreen", forcedScreen->name());
    QVariantMap changed;
    changed.insert(QStringLiteral("forceFSScreen"), forcedScreen->name());
    QVERIFY(QMetaObject::invokeMethod(&manager, "updateMainSectionSettings", Qt::DirectConnection,
                                      Q_ARG(QVariantMap, changed)));
  }
  QTRY_COMPARE(window.geometry(), forcedScreen->geometry());
  QCOMPARE(window.screen(), forcedScreen);
  QVERIFY(coversMonitor());
  QCOMPARE(window.visibility(), QWindow::FullScreen);
  QTRY_COMPARE(refreshedOn.isEmpty() ? nullptr : refreshedOn.last(), forcedScreen);

  manager.setFullScreen(false);
  QTRY_COMPARE(window.visibility(), maximized ? QWindow::Maximized : QWindow::Windowed);
  QTRY_COMPARE(window.geometry(), startGeometry);
  QCOMPARE(window.screen(), homeScreen);
  QVERIFY(!manager.m_fullScreenReturnScreen);
  QTRY_COMPARE(refreshedOn.last(), homeScreen);
  if (maximized) {
    window.showNormal();
    QTRY_COMPARE(window.geometry(), normalGeometry);
  }
  window.hide();
}

// mpv's renderer keeps its place inside the host when the whole window moves
// between two screens of the same size, so it is told to look for its monitor
// again: after the move, not when Qt announces the new screen.
void TestWindowManager::testScreenChangeTellsNativeRenderer()
{
  if (QGuiApplication::platformName() != QStringLiteral("windows"))
    QSKIP("Native child windows require the Windows platform plugin");
  WNDCLASSW rendererClass{};
  rendererClass.lpfnWndProc = rendererFixtureProc;
  rendererClass.hInstance = GetModuleHandleW(nullptr);
  rendererClass.lpszClassName = L"TigerestRendererFixture";
  RegisterClassW(&rendererClass);

  QQuickWindow window;
  window.setGeometry(100, 100, 640, 360);
  QWindow* nativeHost = new QWindow(&window);
  MpvVideoItem item(window.contentItem());
  const bool nativeGpuNext = item.m_nativeGpuNext;
  const auto restoreBackend = qScopeGuard([&]() { item.m_nativeGpuNext = nativeGpuNext; });
  item.m_nativeHostWindow = nativeHost;
  item.m_nativeGpuNext = true;
  item.setSize(QSizeF(300, 170));
  window.show();
  QTRY_VERIFY(nativeHost->isVisible());
  const HWND renderer = CreateWindowExW(0, L"TigerestRendererFixture", L"", WS_CHILD | WS_VISIBLE,
                                        0, 0, 300, 170, reinterpret_cast<HWND>(nativeHost->winId()),
                                        nullptr, GetModuleHandleW(nullptr), nullptr);
  QVERIFY(renderer);
  const auto destroyRenderer = qScopeGuard([&]() { DestroyWindow(renderer); });

  g_rendererDisplayChanges = 0;
  QVERIFY(QMetaObject::invokeMethod(&window, "screenChanged", Qt::DirectConnection,
                                    Q_ARG(QScreen*, window.screen())));
  QCOMPARE(g_rendererDisplayChanges, 0);
  QTRY_COMPARE(g_rendererDisplayChanges, 1);

  // Render API playback draws in the scene: no renderer window to tell.
  item.m_nativeGpuNext = false;
  QVERIFY(QMetaObject::invokeMethod(&window, "screenChanged", Qt::DirectConnection,
                                    Q_ARG(QScreen*, window.screen())));
  QTest::qWait(100);
  QCOMPARE(g_rendererDisplayChanges, 1);
  window.hide();
}

#endif

void TestWindowManager::testMovingToAnotherScreenRefreshesPlaybackPolicy()
{
  QWindow first, second;
  auto& display = DisplayComponent::Get();
  QSignalSpy changed(&display, &DisplayComponent::refreshRateChanged);
  display.setApplicationWindow(&first);
  // Supply the same boundary notification Qt emits on a monitor transition.
  first.screenChanged(first.screen());
  QTRY_COMPARE(changed.count(), 1);
  display.setApplicationWindow(&second);
  first.screenChanged(first.screen());
  second.screenChanged(second.screen());
  QTRY_COMPARE(changed.count(), 2);
  display.setApplicationWindow(nullptr);
  second.screenChanged(second.screen());
  QCoreApplication::processEvents();
  QCOMPARE(changed.count(), 2);
}

void TestWindowManager::testFullscreenStateIsIndependentFromRestoreVisibility()
{
  WindowManager manager;
  QQuickWindow window;
  manager.m_window = &window;
  manager.m_previousVisibility = QWindow::Windowed;
  manager.m_isFullScreen = false;
  connect(&window, SIGNAL(visibilityChanged(QWindow::Visibility)),
          &manager, SLOT(onVisibilityChanged(QWindow::Visibility)));

  QSignalSpy switched(&manager, &WindowManager::fullScreenSwitched);
  window.showNormal();
  QTRY_COMPARE(window.visibility(), QWindow::Windowed);
  manager.beginPlaybackSession();
  manager.setFullScreen(true);
  QTRY_COMPARE(window.visibility(), QWindow::FullScreen);

  QVERIFY(manager.m_isFullScreen);
  QCOMPARE(manager.m_previousVisibility, QWindow::Windowed);
  QVERIFY(manager.m_playbackSessionEnteredFullScreen);
  QCOMPARE(switched.count(), 1);

  manager.setFullScreen(false);
  QTRY_COMPARE(window.visibility(), QWindow::Windowed);
  QVERIFY(!manager.m_isFullScreen);
  QCOMPARE(switched.count(), 2);
  window.hide();
}

void TestWindowManager::testPlaybackSessionRestoresMaximizedWindow()
{
  WindowManager manager;
  QQuickWindow window;
  window.resize(640, 360);
  window.showMaximized();
  QTRY_COMPARE(window.visibility(), QWindow::Maximized);

  manager.m_window = &window;
  manager.m_previousVisibility = QWindow::Maximized;
  manager.m_isFullScreen = false;
  connect(&window, SIGNAL(visibilityChanged(QWindow::Visibility)),
          &manager, SLOT(onVisibilityChanged(QWindow::Visibility)));

  manager.beginPlaybackSession();
  manager.setFullScreen(true);
  QTRY_COMPARE(window.visibility(), QWindow::FullScreen);
  manager.endPlaybackSession();
  QTRY_COMPARE(window.visibility(), QWindow::Maximized);
  window.hide();
}

void TestWindowManager::testPlaybackSessionPreservesPreexistingFullscreen()
{
  WindowManager manager;
  QQuickWindow window;
  window.resize(640, 360);
  window.showFullScreen();
  QTRY_COMPARE(window.visibility(), QWindow::FullScreen);

  manager.m_window = &window;
  manager.m_previousVisibility = QWindow::Windowed;
  manager.m_isFullScreen = true;
  manager.beginPlaybackSession();
  QVERIFY(manager.m_playbackSessionStartedFullScreen);

  manager.endPlaybackSession();
  QCOMPARE(window.visibility(), QWindow::FullScreen);
  window.hide();
}

void TestWindowManager::testPlaybackFullscreenTargetsVideoWindow_data()
{
  QTest::addColumn<bool>("nativeVideo");
  QTest::addColumn<int>("initialVisibility");
  QTest::newRow("render-api-windowed") << false << int(QWindow::Windowed);
  QTest::newRow("render-api-maximized") << false << int(QWindow::Maximized);
  QTest::newRow("native-windowed") << true << int(QWindow::Windowed);
  QTest::newRow("native-maximized") << true << int(QWindow::Maximized);
}

void TestWindowManager::testPlaybackFullscreenTargetsVideoWindow()
{
  QFETCH(bool, nativeVideo);
  QFETCH(int, initialVisibility);
  const auto initial = QWindow::Visibility(initialVisibility);
  WindowManager manager;
  QQuickWindow window;
  window.resize(640, 360);
  window.setVisibility(initial);
  QTRY_COMPARE(window.visibility(), initial);
  manager.m_window = &window;
  manager.m_previousVisibility = initial;
  connect(&window, SIGNAL(visibilityChanged(QWindow::Visibility)),
          &manager, SLOT(onVisibilityChanged(QWindow::Visibility)));
  PlayerComponent::Get().setNativeVideoOutput(nativeVideo);

  manager.beginPlaybackSession();
  QVERIFY(QMetaObject::invokeMethod(&manager, "requestPlaybackFullScreen", Qt::DirectConnection));
#if defined(Q_OS_MAC)
  // A separate mpv window owns fullscreen. The browser must retain its state
  // before it is hidden, including when cancellation restores it asynchronously.
  QTRY_COMPARE(window.visibility(), nativeVideo ? initial : QWindow::FullScreen);
  if (nativeVideo) {
    manager.updateNativePlaybackWindow(true);
    QCOMPARE(window.visibility(), QWindow::Hidden);
  }
#else
  QTRY_COMPARE(window.visibility(), QWindow::FullScreen);
#endif
  manager.endPlaybackSession();
  QTRY_COMPARE(window.visibility(), initial);
  window.hide();
}

void TestWindowManager::testNativePlaybackLeavesCursorAutohideToMpv()
{
  WindowManager manager;
  QQuickWindow window;
  manager.m_window = &window;
  PlayerComponent::Get().setNativeVideoOutput(true);

  manager.beginPlaybackSession();
  manager.setCursorVisibility(false);

  QVERIFY2(!QGuiApplication::overrideCursor(),
           "web mouse-idle installed a global blank cursor during native playback");
}

void TestWindowManager::testEndingNativePlaybackRestoresWebCursorControl()
{
  WindowManager manager;
  QQuickWindow window;
  manager.m_window = &window;
  PlayerComponent::Get().setNativeVideoOutput(true);

  manager.setCursorVisibility(false);
  const QCursor* hiddenCursor = QGuiApplication::overrideCursor();
  QVERIFY(hiddenCursor);
  QCOMPARE(hiddenCursor->shape(), Qt::BlankCursor);

  manager.beginPlaybackSession();
  QVERIFY2(!QGuiApplication::overrideCursor(),
           "native playback did not release the web page's global blank cursor");

  manager.setCursorVisibility(false);
  QVERIFY(!QGuiApplication::overrideCursor());
  manager.endPlaybackSession();
  QVERIFY(!QGuiApplication::overrideCursor());
  QVERIFY(manager.m_cursorVisible);

  manager.setCursorVisibility(false);
  hiddenCursor = QGuiApplication::overrideCursor();
  QVERIFY2(hiddenCursor, "web cursor control was not restored after native playback");
  QCOMPARE(hiddenCursor->shape(), Qt::BlankCursor);
  manager.setCursorVisibility(true);
  QVERIFY(!QGuiApplication::overrideCursor());
}

#if defined(Q_OS_WIN)
void TestWindowManager::testNativePlaybackNormalizesActualWindowsCursor_data()
{
  QTest::addColumn<int>("pageCursor");
  QTest::newRow("page-resize-cursor") << int(Qt::SizeHorCursor);
  QTest::newRow("page-link-cursor") << int(Qt::PointingHandCursor);
}

void TestWindowManager::testNativePlaybackNormalizesActualWindowsCursor()
{
  if (!qEnvironmentVariableIsSet("TIGEREST_TEST_NATIVE_CURSOR"))
    QSKIP("Opt-in pointer integration requires exclusive use of the desktop");
  if (QGuiApplication::platformName() != QStringLiteral("windows"))
    QSKIP("Requires an actual Windows pointer and native GPU-Next window");
  QFETCH(int, pageCursor);
  const QPoint originalPointer = QCursor::pos();
  const auto restorePointer = qScopeGuard([&] { QCursor::setPos(originalPointer); });
  QQuickWindow window;
  window.setFlag(Qt::WindowStaysOnTopHint, true);
  window.setGeometry(150, 150, 640, 420);
  window.setCursor(QCursor(Qt::CursorShape(pageCursor)));
  PlayerComponent player;
  MpvVideoItem item(window.contentItem());
  item.setPosition(QPointF(40, 40));
  item.setSize(QSizeF(560, 340));
  item.setPlayerComponent(&player);
  QWindow* host = item.m_nativeHostWindow;
  QVERIFY(host);
  window.show();
  QTRY_VERIFY(host->isVisible());
  player.setVolume(0);
  const QVariant loaded = item.commandBlocking(QStringList{"loadfile", "av://lavfi:testsrc2=size=320x180:rate=30"});
  QVERIFY(loaded.metaType() != QMetaType::fromType<ErrorReturn>());
  const auto stop = qScopeGuard([&] { player.stop(); item.setVisible(false); window.hide(); });
  QTRY_VERIFY_WITH_TIMEOUT(item.getProperty("vo-configured").toBool(), 10000);
  QTRY_VERIFY_WITH_TIMEOUT(item.getProperty("playback-time").toDouble() > 0.1, 10000);

  const auto currentCursor = [] {
    CURSORINFO cursor{sizeof(CURSORINFO)};
    return GetCursorInfo(&cursor) ? cursor.hCursor : HCURSOR(nullptr);
  };
  const HCURSOR pageHandle = LoadCursor(nullptr, pageCursor == int(Qt::SizeHorCursor) ? IDC_SIZEWE : IDC_HAND);
  const HCURSOR arrow = LoadCursor(nullptr, IDC_ARROW);
  QPoint controlledPosition;
  QTimer pointerKeeper;
  connect(&pointerKeeper, &QTimer::timeout, [&] { QCursor::setPos(controlledPosition); });
  const auto movePointer = [&](const QPoint& position) {
    controlledPosition = position;
    QCursor::setPos(position);
  };
  movePointer(window.mapToGlobal(QPoint(20, 20)));
  pointerKeeper.start(20);
  QTRY_VERIFY(!item.m_nativeCursorInsideHost);
  QTRY_COMPARE(currentCursor(), pageHandle);

  if (pageCursor == int(Qt::SizeHorCursor)) {
    // Exercise a real non-client resize, whose cursor is owned by Windows
    // rather than by the page or the embedded mpv renderer.
    pointerKeeper.stop();
    const HWND mainHwnd = reinterpret_cast<HWND>(window.winId());
    RECT frame{};
    QVERIFY(GetWindowRect(mainHwnd, &frame));
    const POINT border{frame.right - 2, (frame.top + frame.bottom) / 2};
    QVERIFY(SetCursorPos(border.x, border.y));
    QTest::qWait(100);
    QCOMPARE(SendMessage(mainHwnd, WM_NCHITTEST, 0, MAKELPARAM(border.x, border.y)), LRESULT(HTRIGHT));
    QTRY_COMPARE(currentCursor(), LoadCursor(nullptr, IDC_SIZEWE));
    const int widthBeforeResize = window.width();
    // A native sizing loop can block Qt's event loop; release from another
    // thread so even a failed assertion cannot leave the mouse button down.
    std::thread resizeRelease([border] {
      Sleep(100);
      SetCursorPos(border.x + 40, border.y);
      Sleep(100);
      INPUT release{};
      release.type = INPUT_MOUSE;
      release.mi.dwFlags = MOUSEEVENTF_LEFTUP;
      SendInput(1, &release, sizeof(INPUT));
    });
    const auto joinResize = qScopeGuard([&] { if (resizeRelease.joinable()) resizeRelease.join(); });
    INPUT press{};
    press.type = INPUT_MOUSE;
    press.mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
    QCOMPARE(SendInput(1, &press, sizeof(INPUT)), UINT(1));
    QTest::qWait(350);
    QTRY_VERIFY(window.width() > widthBeforeResize);
    QTRY_COMPARE(currentCursor(), LoadCursor(nullptr, IDC_SIZEWE));
    pointerKeeper.start(20);
  }

  movePointer(host->mapToGlobal(QPoint(100, 100)));
  QTRY_VERIFY(item.m_nativeCursorInsideHost);
  QTRY_COMPARE_WITH_TIMEOUT(currentCursor(), arrow, 1500);
  QTRY_COMPARE_WITH_TIMEOUT(host->cursor().shape(), Qt::BlankCursor, 5000);
  QTRY_VERIFY(currentCursor() != arrow && currentCursor() != pageHandle);
  movePointer(host->mapToGlobal(QPoint(120, 100)));
  QTRY_COMPARE_WITH_TIMEOUT(currentCursor(), arrow, 1500);

  // Returning to an underlying page control must restore that control's own
  // cursor, including the horizontal-resize cursor that preceded playback.
  movePointer(window.mapToGlobal(QPoint(20, 20)));
  QTRY_VERIFY(!item.m_nativeCursorInsideHost);
  QTRY_COMPARE(currentCursor(), pageHandle);
  QTest::qWait(3200);
  QCOMPARE(currentCursor(), pageHandle);
  movePointer(host->mapToGlobal(QPoint(100, 100)));
  QTRY_COMPARE_WITH_TIMEOUT(currentCursor(), arrow, 1500);
  item.setVisible(false);
  QTRY_COMPARE(currentCursor(), pageHandle);
  QVERIFY(!QGuiApplication::overrideCursor());
}

void TestWindowManager::testNativePlaybackHidesActualWindowsCursor()
{
  if (!qEnvironmentVariableIsSet("TIGEREST_TEST_NATIVE_CURSOR"))
    QSKIP("Opt-in pointer integration requires exclusive use of the desktop");
  if (QGuiApplication::platformName() != QStringLiteral("windows"))
    QSKIP("Requires an actual Windows pointer and native GPU-Next window");
  const QPoint originalPointer = QCursor::pos();
  const auto restorePointer = qScopeGuard([&] { QCursor::setPos(originalPointer); });
  QQuickWindow window;
  window.setFlag(Qt::WindowStaysOnTopHint, true);
  window.setGeometry(150, 150, 640, 360);
  PlayerComponent player;
  MpvVideoItem item(window.contentItem());
  item.setSize(QSizeF(640, 360));
  item.setPlayerComponent(&player);
  QWindow* host = item.m_nativeHostWindow;
  QVERIFY(host);
  window.show();
  QTRY_VERIFY(host->isVisible());
  player.setVolume(0);
  const QVariant loaded = item.commandBlocking(QStringList{"loadfile", "av://lavfi:testsrc2=size=320x180:rate=30"});
  QVERIFY(loaded.metaType() != QMetaType::fromType<ErrorReturn>());
  const auto stop = qScopeGuard([&] { player.stop(); item.setVisible(false); window.hide(); });
  QTRY_VERIFY_WITH_TIMEOUT(item.getProperty("vo-configured").toBool(), 10000);
  QTRY_VERIFY_WITH_TIMEOUT(item.getProperty("playback-time").toDouble() > 0.1, 10000);

  // Own the test pointer for each short idle interval so other desktop input
  // cannot accidentally turn this into the correctly-visible outside case.
  QPoint controlledPosition;
  QTimer pointerKeeper;
  connect(&pointerKeeper, &QTimer::timeout, [&] { QCursor::setPos(controlledPosition); });
  const auto movePointer = [&](const QPoint& position) {
    controlledPosition = position;
    QCursor::setPos(position);
  };
  movePointer(host->mapToGlobal(QPoint(100, 100)));
  pointerKeeper.start(20);
  QTRY_VERIFY(item.m_nativeCursorInsideHost);
  QTRY_COMPARE(host->cursor().shape(), Qt::ArrowCursor);
  QTRY_COMPARE_WITH_TIMEOUT(host->cursor().shape(), Qt::BlankCursor, 15000);
  const auto currentCursor = [] {
    CURSORINFO cursor{sizeof(CURSORINFO)};
    return GetCursorInfo(&cursor) ? cursor.hCursor : HCURSOR(nullptr);
  };
  QTRY_VERIFY_WITH_TIMEOUT(currentCursor() != LoadCursor(nullptr, IDC_ARROW), 1500);
  movePointer(host->mapToGlobal(QPoint(120, 100)));
  QTRY_COMPARE(host->cursor().shape(), Qt::ArrowCursor);
  QTRY_COMPARE(currentCursor(), LoadCursor(nullptr, IDC_ARROW));
  QTRY_COMPARE_WITH_TIMEOUT(host->cursor().shape(), Qt::BlankCursor, 15000);
  movePointer(window.mapToGlobal(QPoint(-20, -20)));
  QTRY_COMPARE(host->cursor().shape(), Qt::ArrowCursor);
  QTest::qWait(3200);
  QCOMPARE(host->cursor().shape(), Qt::ArrowCursor);
  movePointer(host->mapToGlobal(QPoint(100, 100)));
  QTRY_COMPARE_WITH_TIMEOUT(host->cursor().shape(), Qt::BlankCursor, 15000);
  item.setVisible(false);
  QCOMPARE(host->cursor().shape(), Qt::ArrowCursor);
  QVERIFY(!QGuiApplication::overrideCursor());
}

void TestWindowManager::testNativeVideoAnchorDoesNotPaintOverScene()
{
  if (QGuiApplication::platformName() != QStringLiteral("windows"))
    QSKIP("Requires a real graphics surface");
  QQuickWindow window;
  window.resize(320, 180);
  const QColor background(37, 59, 83);
  window.setColor(background);
  class ObservedNativeItem : public MpvVideoItem {
  public:
    using MpvVideoItem::MpvVideoItem;
    mutable int renderersCreated = 0;
    QQuickFramebufferObject::Renderer* createRenderer() const override {
      ++renderersCreated;
      return MpvVideoItem::createRenderer();
    }
  };
  ObservedNativeItem item(window.contentItem());
  QVERIFY(item.usingNativeGpuNext());
  item.setSize(QSizeF(320, 180));
  window.show();
  QTRY_VERIFY(window.isExposed());
  const QImage rendered = window.grabWindow();
  QVERIFY(!rendered.isNull());
  QCOMPARE(item.renderersCreated, 0);
  QCOMPARE(rendered.pixelColor(rendered.width() / 2, rendered.height() / 2), background);
  item.setVisible(false);
  window.hide();
}

void TestWindowManager::testPlaybackInheritsHostFullscreen_data()
{
  QTest::addColumn<bool>("fullscreen");
  QTest::newRow("library-already-fullscreen") << true;
  QTest::newRow("library-windowed-after-previous-fullscreen-playback") << false;
}

void TestWindowManager::testPlaybackInheritsHostFullscreen()
{
  QFETCH(bool, fullscreen);
  QQuickWindow window;
  window.resize(640, 360);
  MpvVideoItem item(window.contentItem());
  item.setVisible(false);
  item.setPropertyBlocking("fullscreen", !fullscreen);
  window.setVisibility(fullscreen ? QWindow::FullScreen : QWindow::Windowed);
  QTRY_COMPARE(window.visibility(), fullscreen ? QWindow::FullScreen : QWindow::Windowed);

  // Starting playback must publish the existing host state, without needing
  // another window visibility transition to update uosc's fullscreen button.
  item.setVisible(true);
  QTRY_COMPARE(item.getProperty("fullscreen").toBool(), fullscreen);

  // uosc's first click cycles the actual mpv property, so it must immediately
  // request the opposite of the host's state.
  item.commandBlocking(QStringList{"cycle", "fullscreen"});
  QCOMPARE(item.getProperty("fullscreen").toBool(), !fullscreen);

  window.setVisibility(fullscreen ? QWindow::Windowed : QWindow::FullScreen);
  QTRY_COMPARE(item.getProperty("fullscreen").toBool(), !fullscreen);
  if (!fullscreen) {
    window.showMinimized();
    QTRY_COMPARE(window.visibility(), QWindow::Minimized);
    QVERIFY2(item.getProperty("fullscreen").toBool(), "minimizing must not cancel mpv fullscreen");
    window.showFullScreen();
    QTRY_COMPARE(window.visibility(), QWindow::FullScreen);
  }
  item.setVisible(false);
  window.hide();
}

void TestWindowManager::testNativeFullscreenKeepsWindowsComposition_data()
{
  testPlaybackFullscreenTargetsVideoWindow_data();
}

void TestWindowManager::testNativeFullscreenKeepsWindowsComposition()
{
  if (QGuiApplication::platformName() != QStringLiteral("windows"))
    QSKIP("Requires a real Windows HWND to verify DWM fullscreen styles");
  QFETCH(bool, nativeVideo);
  QFETCH(int, initialVisibility);
  const auto initial = QWindow::Visibility(initialVisibility);
  WindowManager manager;
  QQuickWindow window;
  window.resize(640, 360);
  window.setVisibility(initial);
  QTRY_COMPARE(window.visibility(), initial);
  manager.m_window = &window;
  manager.m_previousVisibility = initial;
  connect(&window, SIGNAL(visibilityChanged(QWindow::Visibility)),
          &manager, SLOT(onVisibilityChanged(QWindow::Visibility)));
  PlayerComponent::Get().setNativeVideoOutput(nativeVideo);
  const HWND hwnd = reinterpret_cast<HWND>(window.winId());
  const LONG_PTR frameMask = WS_BORDER | WS_CAPTION | WS_THICKFRAME;
  const LONG_PTR normalFrame = GetWindowLongPtr(hwnd, GWL_STYLE) & frameMask;
  QTRY_VERIFY(window.isExposed());
  const bool openGlScene = window.rendererInterface()->graphicsApi() == QSGRendererInterface::OpenGL;
  // The one-pixel DWM workaround is for an OpenGL scene. Applying it to the
  // D3D11 scene prevents normal fullscreen presentation pacing on NVIDIA.
  const bool needsCompositionBorder = nativeVideo && openGlScene;

  for (int cycle = 0; cycle < 3; ++cycle) {
    manager.beginPlaybackSession();
    manager.setFullScreen(true);
    QTRY_COMPARE(window.visibility(), QWindow::FullScreen);
    QCOMPARE(bool(GetWindowLongPtr(hwnd, GWL_STYLE) & WS_BORDER), needsCompositionBorder);
    QCOMPARE(window.winId(), reinterpret_cast<WId>(hwnd));
    manager.endPlaybackSession();
    QTRY_COMPARE(window.visibility(), initial);
    QCOMPARE(GetWindowLongPtr(hwnd, GWL_STYLE) & frameMask, normalFrame);
  }
  window.hide();
}

void TestWindowManager::testNativeHostTracksMainWindowLifecycle()
{
  QQuickWindow firstWindow;
  QQuickWindow secondWindow;
  firstWindow.setGeometry(100, 100, 640, 360);
  secondWindow.setGeometry(200, 200, 800, 450);

  QWindow* nativeHost = new QWindow(&firstWindow);
  MpvVideoItem item(firstWindow.contentItem());
  item.m_nativeHostWindow = nativeHost;
  item.setPosition(QPointF(11, 19));
  item.setSize(QSizeF(300, 170));
  QTRY_COMPARE(nativeHost->geometry(), QRect(11, 19, 300, 170));
  QCOMPARE(nativeHost->parent(), static_cast<QWindow*>(&firstWindow));
  QVERIFY2(!nativeHost->isVisible(),
           "native video host became visible while the main window was hidden");

  firstWindow.show();
  QTRY_VERIFY(firstWindow.isVisible());
  QTRY_VERIFY(nativeHost->isVisible());
  const WId nativeHostId = nativeHost->winId();
  QVERIFY(nativeHostId != 0);

  firstWindow.showMinimized();
  QTRY_COMPARE(firstWindow.visibility(), QWindow::Minimized);
  QTRY_VERIFY(firstWindow.windowStates().testFlag(Qt::WindowMinimized));
  QTRY_VERIFY2(!nativeHost->isVisible(),
               "native video host remained visible while the main window was minimized");

  firstWindow.showNormal();
  QTRY_COMPARE(firstWindow.visibility(), QWindow::Windowed);
  QTRY_VERIFY(!firstWindow.windowStates().testFlag(Qt::WindowMinimized));
  QTRY_VERIFY(nativeHost->isVisible());

  const QRect staleGeometry(1, 2, 3, 4);
  nativeHost->setGeometry(staleGeometry);
  firstWindow.resize(700, 400);
  QCOMPARE(nativeHost->geometry(), staleGeometry);
  QTRY_COMPARE(nativeHost->geometry(), QRect(11, 19, 300, 170));

  const QRect staleAfterScreenChange(2, 3, 4, 5);
  nativeHost->setGeometry(staleAfterScreenChange);
  QVERIFY(QMetaObject::invokeMethod(&firstWindow, "screenChanged", Qt::DirectConnection,
                                    Q_ARG(QScreen*, firstWindow.screen())));
  QCOMPARE(nativeHost->geometry(), staleAfterScreenChange);
  QTRY_COMPARE(nativeHost->geometry(), QRect(11, 19, 300, 170));
  QCOMPARE(nativeHost->screen(), firstWindow.screen());

  QScreen* screen = firstWindow.screen();
  QVERIFY(screen);
  const QRect staleAfterDpiChange(6, 7, 8, 9);
  nativeHost->setGeometry(staleAfterDpiChange);
  QVERIFY(QMetaObject::invokeMethod(screen, "logicalDotsPerInchChanged", Qt::DirectConnection,
                                    Q_ARG(qreal, screen->logicalDotsPerInch())));
  QCOMPARE(nativeHost->geometry(), staleAfterDpiChange);
  QTRY_COMPARE(nativeHost->geometry(), QRect(11, 19, 300, 170));

  firstWindow.hide();
  QTRY_VERIFY(!nativeHost->isVisible());

  item.setVisible(false);
  item.setParentItem(secondWindow.contentItem());
  QTRY_COMPARE(item.window(), &secondWindow);
  QTRY_COMPARE(nativeHost->parent(), static_cast<QWindow*>(&secondWindow));
  QCOMPARE(nativeHost->screen(), secondWindow.screen());
  QCOMPARE(nativeHost->winId(), nativeHostId);

  secondWindow.show();
  QTRY_VERIFY(secondWindow.isVisible());
  QVERIFY(!nativeHost->isVisible());
  item.setVisible(true);
  QTRY_VERIFY(nativeHost->isVisible());
  secondWindow.hide();
  QTRY_VERIFY(!nativeHost->isVisible());
}
#endif

QTEST_MAIN(TestWindowManager)
#include "test_windowmanager.moc"
