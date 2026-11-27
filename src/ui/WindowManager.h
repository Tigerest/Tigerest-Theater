#ifndef WINDOWMANAGER_H
#define WINDOWMANAGER_H

#include <QObject>
#include <functional>
#include <QAbstractNativeEventFilter>
#include <QPointer>
#include <QQuickItem>
#include <QQuickWindow>
#include <QRect>
#include <QScreen>
#include <QTimer>
#include <QWindow>
#include "core/ComponentManager.h"

#define WEBUI_MAX_HEIGHT 1440.0
#define WEBUI_SIZE QSize(1280, 720)
#define WINDOWW_MIN_SIZE QSize(213, 120)

class WindowManager : public ComponentBase, public QAbstractNativeEventFilter
{
  Q_OBJECT

public:
  static WindowManager& Get();

  explicit WindowManager(QObject* parent = nullptr);
  ~WindowManager() override;

  const char* componentName() override { return "window"; }
  bool componentExport() override { return true; }
  bool componentInitialize() override { return true; }
  void componentPostInitialize() override;

  // Called from main.cpp after window created
  void initializeWindow(QQuickWindow* window);

  // Always on top
  Q_INVOKABLE void setAlwaysOnTop(bool enable);
  Q_INVOKABLE bool isAlwaysOnTop() const;
  Q_INVOKABLE void toggleAlwaysOnTop();

  // Platform detection
  Q_INVOKABLE bool isWayland() const;

  // Fullscreen
  Q_INVOKABLE void setFullScreen(bool enable);
  Q_INVOKABLE bool isFullScreen() const;
  Q_INVOKABLE void requestPlaybackFullScreen();
  Q_INVOKABLE void beginPlaybackSession();
  Q_INVOKABLE void endPlaybackSession();

  // Cursor visibility
  Q_INVOKABLE void setCursorVisibility(bool visible);

  // Event filter for cursor enter/leave tracking
  bool eventFilter(QObject* watched, QEvent* event) override;
  bool nativeEventFilter(const QByteArray& eventType, void* message, qintptr* result) override;

  // Window activation
  Q_INVOKABLE void raiseWindow();

public slots:
  void toggleFullscreen();

signals:
  void fullScreenSwitched();

private slots:
  void onVisibilityChanged(QWindow::Visibility visibility);
  void onScreenAdded(QScreen* screen);
  void onScreenRemoved(QScreen* screen);
  void onScreenGeometryChanged(const QRect& geometry);
  void onScreenDpiChanged(qreal dpi);
  void updateMainSectionSettings(const QVariantMap& values);
  void updateWindowState(bool saveGeo = true);
  void saveGeometrySlot();
  void onZoomFactorChanged();
  void updateDebugInfo();
  void onShowDebugLayerChanged();
  void updateOpenGLInfo();
  void applySettings();

private:
  void configureNativeWindowFrame();
  void prepareFullscreenComposition();
  void updateNativePlaybackWindow(bool visible);
#if defined(Q_OS_MAC)
  // Professional mode while mpv plays in its own Cocoa window: the hidden
  // library window shows the page's panels where the video window was (or
  // fullscreen when it was), and mpv's window becomes its child on the page's
  // video area. Each step waits for the fullscreen transition before it.
  void beginMacProMode();
  void endMacProMode();
  void waitForMacProStep(quint64 serial, int attempts, std::function<bool()> ready, std::function<void()> then);
  bool m_macProMode = false;
  quint64 m_macProSerial = 0;
  QRect m_macProSavedGeometry;
#endif
  bool nativePlaybackOwnsCursor() const;
  void releaseCursorOverrideForNativePlayback();
  // Geometry (separate size/position)
  void loadGeometry();
  QRect loadGeometryRect();
  void saveWindowSize();
  void saveWindowPosition();
  void saveGeometry();  // Calls both size and position
  bool fitsInScreens(const QRect& rc);

  // Config key helpers (per-screen-configuration)
  QString configKeyPrefix() const;
  QString sizeWidthKey() const;
  QString sizeHeightKey() const;
  QString maximizedKey() const;
  QString positionXKey() const;
  QString positionYKey() const;
  QString screenNameKey() const;

  // Screens
  void updateScreens();
  void updateCurrentScreen();
  QScreen* findCurrentScreen();
  QScreen* loadLastScreen();
  // 设置 → 指定全屏显示器: the screen fullscreen should cover, or nullptr
  // when none is chosen or it is not connected.
  QScreen* forcedFullScreenScreen() const;
  void updateForcedScreen();
  // Windows: puts the fullscreen window over the whole of another screen,
  // and before fullscreen ends, back on the screen it came from.
  void moveFullScreenWindow(QScreen* screen);
  void returnFromForcedScreen();

  // Settings
  void connectSettings();

  void enforceZoom();

  QPointer<QQuickWindow> m_window;
  QQuickItem* m_webView;
  bool m_enforcingZoom;
  QString m_currentScreenName;
  int m_ignoreFullscreenSettingsChange;
  bool m_cursorVisible;
  bool m_cursorInsideWindow;
  bool m_cursorOverrideActive;

  // Window state
  QWindow::Visibility m_previousVisibility;  // State before fullscreen
  // The screen the window was on before fullscreen moved it to the forced one.
  QPointer<QScreen> m_fullScreenReturnScreen;
  bool m_isFullScreen;
  bool m_playbackSessionActive;
  bool m_playbackSessionStartedFullScreen;
  bool m_playbackSessionEnteredFullScreen;
  bool m_mainWindowHiddenForNativePlayback;
  QWindow::Visibility m_nativePlaybackPreviousVisibility;
  QRect m_windowedGeometry;                  // Geometry when in Windowed state
  QTimer* m_geometrySaveTimer;               // Debounced disk sync

  // initial size tracking to detect if size changed from default
  QSize m_initialSize;
  QSize m_initialScreenSize;

  // debug info
  QString m_systemDebugInfo;
  QString m_openglInfo;
  QTimer* m_infoTimer;
};

#endif // WINDOWMANAGER_H
