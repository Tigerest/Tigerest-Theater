#include <QtTest/QtTest>
#include <MpvAbstractItem>
#include <QGuiApplication>
#include <QQuickWindow>
#if defined(Q_OS_WIN)
#include <qt_windows.h>
#endif
#include "../src/player/PlayerComponent.h"

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
}

class TestWindowManager : public QObject
{
  Q_OBJECT

private slots:
  void cleanup();
  void testFullscreenStateIsIndependentFromRestoreVisibility();
  void testPlaybackSessionRestoresMaximizedWindow();
  void testPlaybackSessionPreservesPreexistingFullscreen();
  void testPlaybackFullscreenTargetsVideoWindow_data();
  void testPlaybackFullscreenTargetsVideoWindow();
  void testNativePlaybackLeavesCursorAutohideToMpv();
  void testEndingNativePlaybackRestoresWebCursorControl();
#if defined(Q_OS_WIN)
  void testNativeHostTracksMainWindowLifecycle();
  void testNativeFullscreenKeepsWindowsComposition_data();
  void testNativeFullscreenKeepsWindowsComposition();
#endif
};

void TestWindowManager::cleanup()
{
  PlayerComponent::Get().setNativeVideoOutput(false);
  clearOverrideCursor();
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

  for (int cycle = 0; cycle < 3; ++cycle) {
    manager.beginPlaybackSession();
    manager.setFullScreen(true);
    QTRY_COMPARE(window.visibility(), QWindow::FullScreen);
    QCOMPARE(bool(GetWindowLongPtr(hwnd, GWL_STYLE) & WS_BORDER), nativeVideo);
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
