#include "MpvVideoItem.h"

#include "player/MpvConfigManager.h"
#include "PlayerComponent.h"
#include "settings/SettingsComponent.h"
#include <MpvController>
#include <QDebug>
#include <QEnterEvent>
#include <QEvent>
#include <QGuiApplication>
#include <QHoverEvent>
#include <QKeyEvent>
#include <QMouseEvent>
#include <QQuickWindow>
#include <QScreen>
#include <QTimer>
#include <QWindow>
#include <QWheelEvent>
#if defined(Q_OS_WIN)
#include <qt_windows.h>
#endif

namespace
{
constexpr uint64_t FullscreenObserverId = 0x5447534653ULL;
constexpr uint64_t VoObserverId = 0x544753564FULL;
constexpr uint64_t GpuApiObserverId = 0x5447534741ULL;
constexpr uint64_t GpuContextObserverId = 0x5447534743ULL;
}

MpvVideoItem::MpvVideoItem(QQuickItem *parent)
    : MpvAbstractItem(parent)
{
    qDebug() << "MpvVideoItem constructed";
    setAcceptedMouseButtons(Qt::AllButtons);
    setAcceptHoverEvents(true);
    setActiveFocusOnTab(true);
    setFocus(true);

    // The native mpv window must not be parented directly to the Qt/Chromium
    // toplevel.  A dedicated child host makes QML visibility authoritative:
    // hiding this item hides the whole mpv native subtree synchronously before
    // WebEngine is allowed to composite again.
    connect(this, &QQuickItem::visibleChanged, this, &MpvVideoItem::updateNativeHostWindow);
    connect(this, &QQuickItem::visibleChanged, this, &MpvVideoItem::syncFullscreenToMpv);
    connect(this, &QQuickItem::xChanged, this, &MpvVideoItem::updateNativeHostWindow);
    connect(this, &QQuickItem::yChanged, this, &MpvVideoItem::updateNativeHostWindow);
    connect(this, &QQuickItem::widthChanged, this, &MpvVideoItem::updateNativeHostWindow);
    connect(this, &QQuickItem::heightChanged, this, &MpvVideoItem::updateNativeHostWindow);
    connect(this, &QQuickItem::windowChanged, this, &MpvVideoItem::trackWindow);
    trackWindow(window());

    const QString backend = SettingsComponent::Get().value(SETTINGS_SECTION_MPV, "renderBackend").toString();
    m_nativeGpuNext = shouldUseNativeGpuNext(backend);
    // A native video anchor owns input/geometry only. Allocating an unused
    // OpenGL framebuffer would unnecessarily tie the browser scene to OpenGL.
    setFlag(QQuickItem::ItemHasContents, !m_nativeGpuNext);
#if defined(Q_OS_MAC)
    if (m_nativeGpuNext) {
        qInfo() << "Using a separate macOS GPU-Next playback window";
        installMacInputMonitor();
    }
#endif
    setNativeVideoOutput(m_nativeGpuNext);
#if defined(Q_OS_WIN)
    m_nativeCursorIdleTimer.setSingleShot(true);
    m_nativeCursorIdleTimer.setInterval(3000);
    connect(&m_nativeCursorIdleTimer, &QTimer::timeout, this, [this]() {
        if (m_nativeGpuNext && m_nativeHostWindow && m_nativeHostWindow->isVisible() &&
            m_nativeCursorInsideHost)
            m_nativeHostWindow->setCursor(QCursor(Qt::BlankCursor));
    });
    // Once GPU-Next creates its own child HWND, its thread receives pointer
    // events directly. Track actual pointer positions over that host subtree.
    m_nativeCursorTrackingTimer.setInterval(100);
    connect(&m_nativeCursorTrackingTimer, &QTimer::timeout,
            this, &MpvVideoItem::trackNativeHostCursor);
#endif

    if (!m_nativeGpuNext) {
        // Critical: Render-API integration requires vo=libmpv.
        Q_EMIT setProperty("vo", "libmpv");

#ifdef Q_OS_WIN32
        Q_EMIT setProperty("gpu-api", "opengl");
        Q_EMIT setProperty("opengl-es", "no");
#endif
    }
}

MpvVideoItem::~MpvVideoItem()
{
    restoreNativeHostCursor();
    // QQuickItem emits window/visibility changes while its base destructor
    // detaches the item. Our members and MpvAbstractItem's controller have
    // already been destroyed by then, so stop callbacks into this subclass.
    disconnect(this, nullptr, this, nullptr);
#if defined(Q_OS_MAC)
    setMacProAttached(false);
    removeMacInputMonitor();
#endif
}

bool MpvVideoItem::shouldUseNativeGpuNext(const QString& requestedBackend)
{
#if defined(Q_OS_WIN)
    // Windows supports the low-level child HWND path used by GPU-Next. Auto
    // therefore keeps the higher-performance native renderer there.
    return requestedBackend != QStringLiteral("libmpv");
#elif defined(Q_OS_MAC)
    // Cocoa does not support mpv's wid embedding. Use the native GPU-Next
    // window unless the user explicitly selects the Render API fallback.
    return requestedBackend != QStringLiteral("libmpv");
#else
    // Other platforms retain the explicit opt-in used before this policy.
    return requestedBackend == QStringLiteral("gpu-next");
#endif
}

void MpvVideoItem::setPlayerComponent(PlayerComponent* player)
{
    qDebug() << "MpvVideoItem::setPlayerComponent called, mpvController():" << mpvController();
    m_player = player;

    // When mpv is ready, give controller to PlayerComponent
    connect(this, &MpvAbstractItem::ready, this, [this]() {
        qDebug() << "MpvVideoItem ready() signal fired!";
        initializeController();
    });

    // Check if already ready
    if (mpvController()) {
        qDebug() << "MpvVideoItem already ready, initializing now";
        initializeController();
    } else {
        qDebug() << "MpvVideoItem not ready yet, waiting for ready() signal";
    }
}

QWindow* MpvVideoItem::ensureNativeHostWindow()
{
    if (m_nativeHostWindow)
        return m_nativeHostWindow;

    QQuickWindow* parentWindow = window();
    if (!parentWindow)
        return nullptr;

    // QWindow(QWindow*) creates a real platform child. mpv then creates its
    // renderer window below this host instead of below the WebEngine toplevel.
    m_nativeHostWindow = new QWindow(parentWindow);
    m_nativeHostWindow->setObjectName(QStringLiteral("tigerestNativeVideoHost"));
    m_nativeHostWindow->setTitle(QStringLiteral("Tigerest native video host"));
    m_nativeHostWindow->setFlag(Qt::FramelessWindowHint, true);
    // The embedded gpu-next child owns UOSC's mouse and keyboard handling.
    // Marking its Qt host as non-activating prevents Windows from delivering
    // hover/click input to mpv even though the video continues to render.
    m_nativeHostWindow->setFlag(Qt::WindowDoesNotAcceptFocus, false);
    // With --wid mpv renders into this native QWindow instead of the QML
    // scene. The host therefore owns Windows input hit-testing and the
    // QQuickItem handlers below do not receive mouse events. Forward the
    // host's events explicitly so UOSC sees pointer motion, clicks, wheel and
    // keyboard input while retaining the embedded gpu-next renderer.
    m_nativeHostWindow->installEventFilter(this);
    connect(m_nativeHostWindow, &QObject::destroyed, this, [this]() {
        m_nativeHostWindow = nullptr;
    });
    updateNativeHostWindow();
    return m_nativeHostWindow;
}

void MpvVideoItem::trackWindow(QQuickWindow* newWindow)
{
    if (m_trackedWindow != newWindow) {
        if (m_trackedWindow)
            disconnect(m_trackedWindow.data(), nullptr, this, nullptr);

        m_trackedWindow = newWindow;
        if (newWindow) {
            connect(newWindow, &QWindow::xChanged,
                    this, &MpvVideoItem::scheduleNativeHostWindowUpdate);
            connect(newWindow, &QWindow::yChanged,
                    this, &MpvVideoItem::scheduleNativeHostWindowUpdate);
            connect(newWindow, &QWindow::widthChanged,
                    this, &MpvVideoItem::scheduleNativeHostWindowUpdate);
            connect(newWindow, &QWindow::heightChanged,
                    this, &MpvVideoItem::scheduleNativeHostWindowUpdate);
            connect(newWindow, &QWindow::visibilityChanged,
                    this, &MpvVideoItem::scheduleNativeHostWindowUpdate);
            connect(newWindow, &QWindow::visibilityChanged,
                    this, &MpvVideoItem::syncFullscreenToMpv, Qt::QueuedConnection);
            connect(newWindow, &QWindow::windowStateChanged,
                    this, &MpvVideoItem::scheduleNativeHostWindowUpdate);
            connect(newWindow, &QWindow::screenChanged, this, [this](QScreen* screen) {
                trackScreen(screen);
                scheduleNativeHostWindowUpdate();
#if defined(Q_OS_WIN)
                // Qt can announce the screen before the window has arrived
                // there (QWindow::setGeometry does); tell mpv afterwards.
                QTimer::singleShot(0, this, &MpvVideoItem::notifyNativeDisplayChange);
#endif
            });
        }
    }

    trackScreen(newWindow ? newWindow->screen() : nullptr);
    scheduleNativeHostWindowUpdate();
}

void MpvVideoItem::trackScreen(QScreen* newScreen)
{
    if (m_trackedScreen == newScreen)
        return;

    if (m_trackedScreen)
        disconnect(m_trackedScreen.data(), nullptr, this, nullptr);

    m_trackedScreen = newScreen;
    if (!newScreen)
        return;

    connect(newScreen, &QScreen::geometryChanged,
            this, &MpvVideoItem::scheduleNativeHostWindowUpdate);
    connect(newScreen, &QScreen::availableGeometryChanged,
            this, &MpvVideoItem::scheduleNativeHostWindowUpdate);
    connect(newScreen, &QScreen::logicalDotsPerInchChanged,
            this, &MpvVideoItem::scheduleNativeHostWindowUpdate);
    connect(newScreen, &QScreen::physicalDotsPerInchChanged,
            this, &MpvVideoItem::scheduleNativeHostWindowUpdate);
}

void MpvVideoItem::scheduleNativeHostWindowUpdate()
{
    if (m_nativeHostUpdatePending)
        return;

    m_nativeHostUpdatePending = true;
    QTimer::singleShot(0, this, [this]() {
        m_nativeHostUpdatePending = false;
        updateNativeHostWindow();
    });
}

bool MpvVideoItem::eventFilter(QObject* watched, QEvent* event)
{
    if (watched != m_nativeHostWindow)
        return MpvAbstractItem::eventFilter(watched, event);

    switch (event->type()) {
    case QEvent::Enter: {
        auto* enter = static_cast<QEnterEvent*>(event);
        sendMousePosition(enter->position());
        commandAsync({QStringLiteral("keypress"), QStringLiteral("MOUSE_ENTER")});
        event->accept();
        return true;
    }
    case QEvent::Leave:
        commandAsync({QStringLiteral("keypress"), QStringLiteral("MOUSE_LEAVE")});
        event->accept();
        return true;
    case QEvent::MouseMove:
        mouseMoveEvent(static_cast<QMouseEvent*>(event));
        return true;
    case QEvent::MouseButtonPress:
        mousePressEvent(static_cast<QMouseEvent*>(event));
        return true;
    case QEvent::MouseButtonRelease:
        mouseReleaseEvent(static_cast<QMouseEvent*>(event));
        return true;
    case QEvent::MouseButtonDblClick:
        mouseDoubleClickEvent(static_cast<QMouseEvent*>(event));
        return true;
    case QEvent::Wheel:
        wheelEvent(static_cast<QWheelEvent*>(event));
        return true;
    case QEvent::KeyPress:
        keyPressEvent(static_cast<QKeyEvent*>(event));
        return true;
    case QEvent::KeyRelease:
        keyReleaseEvent(static_cast<QKeyEvent*>(event));
        return true;
    case QEvent::Hide:
        restoreNativeHostCursor();
        break;
    default:
        break;
    }

    return MpvAbstractItem::eventFilter(watched, event);
}

void MpvVideoItem::updateNativeHostWindow()
{
#if defined(Q_OS_MAC)
    // Professional mode keeps mpv's own window on this item's rectangle.
    if (m_macProAttached)
        updateMacProFrame();
#endif
    if (!m_nativeHostWindow)
        return;

    QQuickWindow* parentWindow = window();
    if (!parentWindow) {
        restoreNativeHostCursor();
        m_nativeHostWindow->hide();
        return;
    }

    // A child QWindow inherits its screen from its parent. Reparenting keeps
    // that inheritance intact without calling setScreen(), which only applies
    // to top-level windows and can recreate their native platform handle.
    if (m_nativeHostWindow->parent() != parentWindow)
        m_nativeHostWindow->setParent(parentWindow);

    const QPointF scenePosition = mapToScene(QPointF(0.0, 0.0));
    const QRect geometry(qRound(scenePosition.x()), qRound(scenePosition.y()),
                         qMax(1, qRound(width())), qMax(1, qRound(height())));
    if (m_nativeHostWindow->geometry() != geometry)
        m_nativeHostWindow->setGeometry(geometry);

    const QWindow::Visibility parentVisibility = parentWindow->visibility();
    const bool parentCanShowNativeHost = parentVisibility != QWindow::Hidden &&
                                         parentVisibility != QWindow::Minimized;
    const bool shouldShow = parentCanShowNativeHost && parentWindow->isVisible() && isVisible() &&
                            width() > 0.0 && height() > 0.0;
    if (shouldShow) {
        m_nativeHostWindow->show();
        m_nativeHostWindow->raise();
        // In professional mode the page beside the video may hold the
        // keyboard; resizing the video must not take it away.
        if (!(m_player && m_player->proModeActive()))
            m_nativeHostWindow->requestActivate();
#if defined(Q_OS_WIN)
        if (!m_nativeCursorTrackingTimer.isActive())
            m_nativeCursorTrackingTimer.start();
#endif
    } else {
        // This is intentionally synchronous with QML's visible binding.  mpv
        // can finish tearing down its own child later without touching the
        // WebEngine surface that is about to become visible again.
        restoreNativeHostCursor();
#if defined(Q_OS_WIN)
        m_nativeCursorTrackingTimer.stop();
#endif
        m_nativeHostWindow->hide();
    }
}

#if defined(Q_OS_WIN)
void MpvVideoItem::notifyNativeDisplayChange()
{
    // mpv looks for its monitor again when its own window moves or resizes.
    // When the whole window moves between two screens of the same size (a
    // drag, or fullscreen on the chosen display), the renderer keeps its
    // place and size inside the host, so mpv kept the old monitor: its display
    // names, DPI, display-fps and ICC profile. WM_DISPLAYCHANGE makes it read
    // them anew. Every window below the host is mpv's.
    if (!m_nativeGpuNext || !m_nativeHostWindow || !m_nativeHostWindow->handle())
        return;
    const HWND host = reinterpret_cast<HWND>(m_nativeHostWindow->winId());
    EnumChildWindows(host, [](HWND child, LPARAM) -> BOOL {
        MONITORINFO monitor{};
        monitor.cbSize = sizeof(monitor);
        LPARAM size = 0;
        if (GetMonitorInfoW(MonitorFromWindow(child, MONITOR_DEFAULTTONEAREST), &monitor))
            size = MAKELPARAM(monitor.rcMonitor.right - monitor.rcMonitor.left,
                              monitor.rcMonitor.bottom - monitor.rcMonitor.top);
        PostMessageW(child, WM_DISPLAYCHANGE, 32, size);
        return TRUE;
    }, 0);
}

void MpvVideoItem::trackNativeHostCursor()
{
    if (!m_nativeGpuNext || !m_nativeHostWindow || !m_nativeHostWindow->isVisible()) {
        restoreNativeHostCursor();
        m_nativeCursorTrackingTimer.stop();
        return;
    }
    const QPoint globalPosition = QCursor::pos();
    const HWND host = reinterpret_cast<HWND>(m_nativeHostWindow->winId());
    POINT nativePosition{};
    if (!GetCursorPos(&nativePosition)) {
        restoreNativeHostCursor();
        return;
    }
    const HWND pointerWindow = WindowFromPoint(nativePosition);
    if (pointerWindow != host && !IsChild(host, pointerWindow)) {
        restoreNativeHostCursor();
        return;
    }
    noteNativeHostPointerActivity(m_nativeHostWindow->mapFromGlobal(globalPosition));
    // Professional mode: a click on the page beside the video gives the page
    // the keyboard. mpv's window takes clicks on its own thread, so Qt never
    // sees one on the video; the pointer resting over the video hands the
    // keyboard back instead. Not during a drag that began on the page.
    if (m_player && m_player->proModeActive() && window() &&
        QGuiApplication::focusWindow() == window() &&
        !(GetAsyncKeyState(VK_LBUTTON) & 0x8000))
        focusNativeHost();
}
#endif

void MpvVideoItem::focusNativeHost()
{
    forceActiveFocus();
    if (m_nativeHostWindow && m_nativeHostWindow->isVisible())
        m_nativeHostWindow->requestActivate();
}

void MpvVideoItem::restoreNativeHostCursor()
{
#if defined(Q_OS_WIN)
    m_nativeCursorIdleTimer.stop();
    m_nativeCursorInsideHost = false;
    if (m_nativeHostWindow)
        m_nativeHostWindow->unsetCursor();
#endif
}

void MpvVideoItem::noteNativeHostPointerActivity(const QPointF& position)
{
#if defined(Q_OS_WIN)
    if (!m_nativeGpuNext || !m_nativeHostWindow || !m_nativeHostWindow->isVisible())
        return;
    if (m_nativeCursorInsideHost && position == m_nativeCursorPosition)
        return;
    m_nativeCursorPosition = position;
    m_nativeCursorInsideHost = true;
    // Unsetting a child window's cursor inherits its parent (or leaves an
    // already-unset native cursor untouched). A resize/link cursor from the
    // page must never carry into the video surface.
    m_nativeHostWindow->setCursor(QCursor(Qt::ArrowCursor));
    m_nativeCursorIdleTimer.start();
#else
    Q_UNUSED(position);
#endif
}

void MpvVideoItem::initializeController()
{
#ifdef Q_OS_WIN
    if (m_player && m_player->isShuttingDown())
        return;
#endif
    MpvController* controller = mpvController();
    if (!m_player || !controller) {
        qWarning() << "Cannot initialize MPV controller; player:" << m_player
                   << "controller:" << controller;
        return;
    }
    if (m_initializedController == controller)
        return;

    m_initializedController = controller;

    qDebug() << "Setting mpv controller and initializing";
    m_player->setNativeVideoOutput(m_nativeGpuNext);
    // The macOS GPU-Next window owns its own fullscreen state. Forwarding that
    // property to QML would fullscreen the hidden Emby window instead.
#if defined(Q_OS_MAC)
    if (!m_nativeGpuNext)
#endif
        connect(m_player, &PlayerComponent::fullscreenRequested, this,
                &MpvVideoItem::fullscreenRequested, Qt::UniqueConnection);

    if (m_nativeGpuNext) {
#if defined(Q_OS_MAC)
        // macOS has no supported wid embedding path. Explicitly detach from
        // any stale host and let gpu-next create its native Cocoa/macvk window.
        const int widResult = setPropertyBlocking(QStringLiteral("wid"), qlonglong{-1});
        const int voResult = setPropertyBlocking(QStringLiteral("vo"), QStringLiteral("gpu-next"));
        const int apiResult = setPropertyBlocking(QStringLiteral("gpu-api"), QStringLiteral("vulkan"));
        const int contextResult = setPropertyBlocking(QStringLiteral("gpu-context"), QStringLiteral("macvk"));
        setPropertyBlocking(QStringLiteral("input-vo-keyboard"), true);
        setPropertyBlocking(QStringLiteral("input-cursor"), true);
        if (widResult < 0 || voResult < 0 || apiResult < 0 || contextResult < 0) {
            qCritical() << "Unable to initialize macOS native gpu-next window; wid="
                        << widResult << "vo=" << voResult << "api=" << apiResult
                        << "context=" << contextResult;
        } else {
            qInfo() << "macOS native gpu-next window configured with macvk";
        }
#else
        QWindow* nativeHost = ensureNativeHostWindow();
        if (!nativeHost) {
            qCritical() << "Native gpu-next requested before its host window exists";
            return;
        }
        // mpv creates its renderer child below the dedicated native host. This
        // preserves the real vo=gpu-next path while isolating Chromium's scene.
        const quintptr rawId = static_cast<quintptr>(nativeHost->winId());
        const qlonglong windowId = static_cast<qlonglong>(rawId);
        const int widResult = setPropertyBlocking(QStringLiteral("wid"), windowId);
        const int voResult = setPropertyBlocking(QStringLiteral("vo"), QStringLiteral("gpu-next"));
        setPropertyBlocking(QStringLiteral("input-vo-keyboard"), true);
        setPropertyBlocking(QStringLiteral("input-cursor"), true);
#if defined(Q_OS_WIN)
        // Input can arrive at either the Qt host or mpv's child HWND. Keep a
        // single local cursor owner for both; UOSC still receives pointer input.
        setPropertyBlocking(QStringLiteral("cursor-autohide"), QStringLiteral("no"));
#endif
        if (widResult < 0 || voResult < 0) {
            qCritical() << "Unable to initialize native gpu-next embedding; wid="
                        << widResult << "vo=" << voResult;
        } else {
            qInfo() << "Native gpu-next embedded into dedicated host window" << windowId;
        }
#endif
    } else {
        setPropertyBlocking(QStringLiteral("vo"), QStringLiteral("libmpv"));
    }

    m_player->setMpvController(controller);
    m_player->initializeMpv();
    Q_EMIT observeProperty(QStringLiteral("fullscreen"), MPV_FORMAT_FLAG, FullscreenObserverId);
    Q_EMIT observeProperty(QStringLiteral("vo"), MPV_FORMAT_STRING, VoObserverId);
    Q_EMIT observeProperty(QStringLiteral("gpu-api"), MPV_FORMAT_STRING, GpuApiObserverId);
    Q_EMIT observeProperty(QStringLiteral("gpu-context"), MPV_FORMAT_STRING, GpuContextObserverId);
}

void MpvVideoItem::syncFullscreenToMpv()
{
#ifdef Q_OS_WIN
    // A queued fullscreen/visibility event can arrive after exit was requested.
    // The VO may be waiting on this GUI thread to release its native window.
    if (m_player && m_player->isShuttingDown())
        return;
#endif
#if defined(Q_OS_MAC)
    // Native Cocoa playback has its own window, independent of the library.
    if (m_nativeGpuNext)
        return;
#endif
    if (!isVisible() || !window() || !mpvController())
        return;

    const auto visibility = window()->visibility();
    if (visibility == QWindow::Hidden || visibility == QWindow::Minimized)
        return;

    // uosc cycles mpv's fullscreen property. Publish the host's existing state
    // when playback becomes visible, even if the host was already fullscreen.
    const int result = setPropertyBlocking(QStringLiteral("fullscreen"),
                                           visibility == QWindow::FullScreen);
    if (result < 0)
        qWarning() << "Unable to synchronize playback fullscreen state:" << result;
}

void MpvVideoItem::sendMousePosition(const QPointF& position)
{
    const qreal dpr = window() ? window()->devicePixelRatio() : 1.0;
    const int x = qRound(qBound(0.0, position.x(), width()) * dpr);
    const int y = qRound(qBound(0.0, position.y(), height()) * dpr);
    commandAsync({QStringLiteral("mouse"), QString::number(x), QString::number(y)});
}

QString MpvVideoItem::mouseButtonName(Qt::MouseButton button) const
{
    switch (button) {
    case Qt::LeftButton: return QStringLiteral("MOUSE_BTN0");
    case Qt::MiddleButton: return QStringLiteral("MOUSE_BTN1");
    case Qt::RightButton: return QStringLiteral("MOUSE_BTN2");
    case Qt::BackButton: return QStringLiteral("MOUSE_BTN3");
    case Qt::ForwardButton: return QStringLiteral("MOUSE_BTN4");
    default: return QString();
    }
}

QString MpvVideoItem::keyName(QKeyEvent* event) const
{
    QString base;
    switch (event->key()) {
    case Qt::Key_Space: base = QStringLiteral("SPACE"); break;
    case Qt::Key_Left: base = QStringLiteral("LEFT"); break;
    case Qt::Key_Right: base = QStringLiteral("RIGHT"); break;
    case Qt::Key_Up: base = QStringLiteral("UP"); break;
    case Qt::Key_Down: base = QStringLiteral("DOWN"); break;
    case Qt::Key_Return: base = QStringLiteral("ENTER"); break;
    case Qt::Key_Enter: base = QStringLiteral("KP_ENTER"); break;
    case Qt::Key_Escape: base = QStringLiteral("ESC"); break;
    case Qt::Key_Backspace: base = QStringLiteral("BS"); break;
    case Qt::Key_Tab: base = QStringLiteral("TAB"); break;
    case Qt::Key_Home: base = QStringLiteral("HOME"); break;
    case Qt::Key_End: base = QStringLiteral("END"); break;
    case Qt::Key_PageUp: base = QStringLiteral("PGUP"); break;
    case Qt::Key_PageDown: base = QStringLiteral("PGDWN"); break;
    case Qt::Key_Delete: base = QStringLiteral("DEL"); break;
    case Qt::Key_Insert: base = QStringLiteral("INS"); break;
    default:
        if (event->key() >= Qt::Key_F1 && event->key() <= Qt::Key_F35) {
            base = QStringLiteral("F%1").arg(event->key() - Qt::Key_F1 + 1);
        } else if (event->key() >= Qt::Key_A && event->key() <= Qt::Key_Z) {
            const QChar letter('a' + event->key() - Qt::Key_A);
            base = (event->modifiers() & Qt::ShiftModifier) ? letter.toUpper() : letter;
        } else if (!event->text().isEmpty() && event->text().front().isPrint()) {
            base = event->text().front();
        }
        break;
    }

    if (base.isEmpty())
        return base;

    QStringList modifiers;
    if (event->modifiers() & Qt::ControlModifier) modifiers << QStringLiteral("Ctrl");
    if (event->modifiers() & Qt::AltModifier) modifiers << QStringLiteral("Alt");
    if (event->modifiers() & Qt::MetaModifier) modifiers << QStringLiteral("Meta");
    const bool shiftAlreadyEncoded = base.size() == 1 && base.front().isPrint();
    if ((event->modifiers() & Qt::ShiftModifier) && !shiftAlreadyEncoded)
        modifiers << QStringLiteral("Shift");
    modifiers << base;
    return modifiers.join('+');
}

void MpvVideoItem::hoverEnterEvent(QHoverEvent* event)
{
    sendMousePosition(event->position());
    commandAsync({QStringLiteral("keypress"), QStringLiteral("MOUSE_ENTER")});
    event->accept();
}

void MpvVideoItem::hoverMoveEvent(QHoverEvent* event)
{
    sendMousePosition(event->position());
    event->accept();
}

void MpvVideoItem::hoverLeaveEvent(QHoverEvent* event)
{
    commandAsync({QStringLiteral("keypress"), QStringLiteral("MOUSE_LEAVE")});
    event->accept();
}

void MpvVideoItem::mouseMoveEvent(QMouseEvent* event)
{
    sendMousePosition(event->position());
    event->accept();
}

void MpvVideoItem::mousePressEvent(QMouseEvent* event)
{
    sendMousePosition(event->position());
    const QString button = mouseButtonName(event->button());
    if (!button.isEmpty())
        commandAsync({QStringLiteral("keydown"), button});
    forceActiveFocus();
    event->accept();
}

void MpvVideoItem::mouseReleaseEvent(QMouseEvent* event)
{
    sendMousePosition(event->position());
    if (event->button() == Qt::LeftButton && m_leftDoubleClickHandledLocally) {
        // Qt delivers a double-click event instead of the second press, but it
        // still delivers the matching release.  The double-click is handled
        // directly below, so forwarding this unmatched keyup can make mpv/UOSC
        // interpret one gesture twice.
        m_leftDoubleClickHandledLocally = false;
        event->accept();
        return;
    }
    const QString button = mouseButtonName(event->button());
    if (!button.isEmpty())
        commandAsync({QStringLiteral("keyup"), button});
    event->accept();
}

void MpvVideoItem::mouseDoubleClickEvent(QMouseEvent* event)
{
    sendMousePosition(event->position());
    if (event->button() == Qt::LeftButton) {
        // Do not combine mpv's own click timing with an explicitly injected
        // double-click.  That can toggle pause twice and appear to do nothing.
        togglePause();
        m_leftDoubleClickHandledLocally = true;
        event->accept();
        return;
    }

    const qreal dpr = window() ? window()->devicePixelRatio() : 1.0;
    const int x = qRound(qBound(0.0, event->position().x(), width()) * dpr);
    const int y = qRound(qBound(0.0, event->position().y(), height()) * dpr);
    QString button = mouseButtonName(event->button());
    const int buttonNumber = button.isEmpty() ? -1 : button.mid(QStringLiteral("MOUSE_BTN").size()).toInt();
    if (buttonNumber >= 0) {
        commandAsync({QStringLiteral("mouse"), QString::number(x), QString::number(y),
                      QString::number(buttonNumber), QStringLiteral("double")});
    }
    event->accept();
}

void MpvVideoItem::wheelEvent(QWheelEvent* event)
{
    sendMousePosition(event->position());
    const QPoint delta = event->angleDelta();
    const bool isVerticalWheel = qAbs(delta.y()) >= qAbs(delta.x());
    QString wheel;
    int amount = 0;
    if (isVerticalWheel) {
        wheel = delta.y() >= 0 ? QStringLiteral("WHEEL_UP") : QStringLiteral("WHEEL_DOWN");
        amount = qAbs(delta.y());
    } else {
        wheel = delta.x() >= 0 ? QStringLiteral("WHEEL_RIGHT") : QStringLiteral("WHEEL_LEFT");
        amount = qAbs(delta.x());
    }
    const double scale = qMax(1.0, amount / 120.0);
    commandAsync({QStringLiteral("keypress"), wheel, QString::number(scale, 'f', 3)});
    if (isVerticalWheel) {
        commandAsync({QStringLiteral("script-binding"),
                      QStringLiteral("uosc/flash-volume")});
    }
    event->accept();
}

void MpvVideoItem::keyPressEvent(QKeyEvent* event)
{
#ifdef Q_OS_WIN
    if (m_player && m_player->isShuttingDown()) {
        if (event->key() == Qt::Key_F4 && event->modifiers() == Qt::AltModifier)
            m_player->requestApplicationQuit();
        event->accept();
        return;
    }
#endif
    if (event->isAutoRepeat()) {
        event->accept();
        return;
    }

    // A key the user binds in the custom area of mpv/input.conf belongs to the
    // user: hand it to mpv before any of the host's fallback actions (Esc,
    // Space, F11, Ctrl+J, Alt+1..3), so the file can rebind them as well.
    const QString boundKey = keyName(event);
    if (!boundKey.isEmpty() && MpvConfigManager::userKeymapHasBinding(boundKey)) {
        commandAsync({QStringLiteral("keydown"), boundKey});
        event->accept();
        return;
    }

    // Alt+1..3 select the three bundled quality profiles. The player applies
    // them from the current mpv.conf, as the uosc menu and the settings page do.
    if (event->modifiers() == Qt::AltModifier &&
        event->key() >= Qt::Key_1 && event->key() <= Qt::Key_3) {
        static const QStringList profiles = {QStringLiteral("tigerest-default"),
                                             QStringLiteral("tigerest-liveaction"),
                                             QStringLiteral("tigerest-aggressive-test")};
        if (m_player)
            m_player->applyQualityProfile(profiles.at(event->key() - Qt::Key_1), true);
        m_profileHandledLocally = true;
        event->accept();
        return;
    }

    if (event->key() == Qt::Key_F11 && event->modifiers() == Qt::NoModifier) {
        const bool fullscreen = window() && window()->visibility() == QWindow::FullScreen;
        m_fullscreenHandledLocally = true;
        Q_EMIT fullscreenRequested(!fullscreen);
        event->accept();
        return;
    }

    if (event->key() == Qt::Key_J &&
        (event->modifiers() & Qt::ControlModifier) &&
        !(event->modifiers() & (Qt::AltModifier | Qt::MetaModifier))) {
        m_statsHandledLocally = true;
        const bool fullPipeline = event->modifiers() & Qt::ShiftModifier;
        commandAsync({QStringLiteral("script-binding"),
                      fullPipeline ? QStringLiteral("stats/display-page-2")
                                   : QStringLiteral("stats/display-stats-toggle")});
        event->accept();
        return;
    }

    if (event->key() == Qt::Key_Escape) {
        const QString menuType = getProperty(QStringLiteral("user-data/uosc/menu/type")).toString();
        const bool uoscMenuOpen = !menuType.isEmpty() && menuType != QStringLiteral("undefined");
        if (!uoscMenuOpen) {
            m_escapeHandledLocally = true;
            commandAsync({QStringLiteral("stop")});
            event->accept();
            return;
        }
    }

    // libmpv disables its built-in key table in some embedding modes.  Keep
    // the conventional pause key available without changing any explicit
    // bindings from the user's input.conf.
    if (event->key() == Qt::Key_Space && event->modifiers() == Qt::NoModifier) {
        m_spaceHandledLocally = true;
        togglePause();
        event->accept();
        return;
    }

    if (!boundKey.isEmpty())
        commandAsync({QStringLiteral("keydown"), boundKey});
    event->accept();
}

void MpvVideoItem::togglePause()
{
    // Qt-hosted input must change preparation intent before touching mpv's
    // physical pause. Standalone items retain their normal native toggle.
    if(m_player)m_player->togglePause();
    else commandAsync({QStringLiteral("cycle"), QStringLiteral("pause")});
}

void MpvVideoItem::keyReleaseEvent(QKeyEvent* event)
{
    if (event->isAutoRepeat()) {
        event->accept();
        return;
    }
    if (event->key() == Qt::Key_Escape && m_escapeHandledLocally) {
        m_escapeHandledLocally = false;
        event->accept();
        return;
    }
    if (event->key() == Qt::Key_Space && m_spaceHandledLocally) {
        m_spaceHandledLocally = false;
        event->accept();
        return;
    }
    if (event->key() >= Qt::Key_1 && event->key() <= Qt::Key_3 && m_profileHandledLocally) {
        m_profileHandledLocally = false;
        event->accept();
        return;
    }
    if (event->key() == Qt::Key_F11 && m_fullscreenHandledLocally) {
        m_fullscreenHandledLocally = false;
        event->accept();
        return;
    }
    if (event->key() == Qt::Key_J && m_statsHandledLocally) {
        m_statsHandledLocally = false;
        event->accept();
        return;
    }
    const QString key = keyName(event);
    if (!key.isEmpty())
        commandAsync({QStringLiteral("keyup"), key});
    event->accept();
}
