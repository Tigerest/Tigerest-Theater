#ifndef MPVVIDEOITEM_H
#define MPVVIDEOITEM_H

#include <MpvAbstractItem>
#include <QHash>
#include <QPointF>
#include <QPointer>
#include <QString>
#include <QTimer>
#include <Qt>

class PlayerComponent;
class QHoverEvent;
class QKeyEvent;
class QMouseEvent;
class QEvent;
class QQuickWindow;
class QScreen;
class QWindow;
class QWheelEvent;

class MpvVideoItem : public MpvAbstractItem
{
    Q_OBJECT
    QML_ELEMENT
    Q_PROPERTY(bool nativeGpuNext READ usingNativeGpuNext CONSTANT)

public:
    explicit MpvVideoItem(QQuickItem *parent = nullptr);
    ~MpvVideoItem() override;
    void setPlayerComponent(PlayerComponent* player);
    bool usingNativeGpuNext() const { return m_nativeGpuNext; }
    static bool shouldUseNativeGpuNext(const QString& requestedBackend);

    MpvController* controller() { return mpvController(); }
    // Keyboard input for mpv and uosc: this item in the scene and, with the
    // embedded gpu-next window, its native host.
    Q_INVOKABLE void focusNativeHost();

Q_SIGNALS:
    void fullscreenRequested(bool fullscreen);

protected:
    bool eventFilter(QObject* watched, QEvent* event) override;
    void hoverEnterEvent(QHoverEvent* event) override;
    void hoverMoveEvent(QHoverEvent* event) override;
    void hoverLeaveEvent(QHoverEvent* event) override;
    void mouseMoveEvent(QMouseEvent* event) override;
    void mousePressEvent(QMouseEvent* event) override;
    void mouseReleaseEvent(QMouseEvent* event) override;
    void mouseDoubleClickEvent(QMouseEvent* event) override;
    void wheelEvent(QWheelEvent* event) override;
    void keyPressEvent(QKeyEvent* event) override;
    void keyReleaseEvent(QKeyEvent* event) override;

private:
    friend class RifePlayerPlayback;
#if defined(Q_OS_MAC)
    void installMacInputMonitor();
    void removeMacInputMonitor();
    void releaseMacKeys();
    void* m_macInputMonitor = nullptr;
    void* m_macInputFocusObserver = nullptr;
    QHash<unsigned short, QString> m_macPressedKeys;
#endif
    void initializeController();
    QWindow* ensureNativeHostWindow();
    void trackWindow(QQuickWindow* window);
    void trackScreen(QScreen* screen);
    void scheduleNativeHostWindowUpdate();
    void updateNativeHostWindow();
    void syncFullscreenToMpv();
    void restoreNativeHostCursor();
    void noteNativeHostPointerActivity(const QPointF& position);
#if defined(Q_OS_WIN)
    void trackNativeHostCursor();
#endif
    void sendMousePosition(const QPointF& position);
    void togglePause();
    QString mouseButtonName(Qt::MouseButton button) const;
    QString keyName(QKeyEvent* event) const;

    PlayerComponent* m_player = nullptr;
    bool m_escapeHandledLocally = false;
    bool m_spaceHandledLocally = false;
    bool m_leftDoubleClickHandledLocally = false;
    bool m_fullscreenHandledLocally = false;
    bool m_statsHandledLocally = false;
    bool m_profileHandledLocally = false;
    bool m_nativeGpuNext = false;
    bool m_nativeHostUpdatePending = false;
    QWindow* m_nativeHostWindow = nullptr;
#if defined(Q_OS_WIN)
    QTimer m_nativeCursorIdleTimer;
    QTimer m_nativeCursorTrackingTimer;
    QPointF m_nativeCursorPosition;
    bool m_nativeCursorInsideHost = false;
#endif
    QPointer<QQuickWindow> m_trackedWindow;
    QPointer<QScreen> m_trackedScreen;
    MpvController* m_initializedController = nullptr;
};

#endif // MPVVIDEOITEM_H
