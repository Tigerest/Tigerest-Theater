#include <QtTest/QtTest>
#include <QQuickWindow>

#define private public
#include "../src/ui/WindowManager.h"
#undef private

class TestWindowManager : public QObject
{
  Q_OBJECT

private slots:
  void testFullscreenStateIsIndependentFromRestoreVisibility();
  void testPlaybackSessionRestoresMaximizedWindow();
  void testPlaybackSessionPreservesPreexistingFullscreen();
};

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

QTEST_MAIN(TestWindowManager)
#include "test_windowmanager.moc"
