#include "MpvVideoItem.h"
#include "PlayerComponent.h"
#include "settings/SettingsComponent.h"
#include <MpvController>
#include <QDebug>
#include <QEnterEvent>
#include <QEvent>
#include <QHoverEvent>
#include <QKeyEvent>
#include <QMouseEvent>
#include <QQuickWindow>
#include <QWindow>
#include <QWheelEvent>

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
    connect(this, &QQuickItem::xChanged, this, &MpvVideoItem::updateNativeHostWindow);
    connect(this, &QQuickItem::yChanged, this, &MpvVideoItem::updateNativeHostWindow);
    connect(this, &QQuickItem::widthChanged, this, &MpvVideoItem::updateNativeHostWindow);
    connect(this, &QQuickItem::heightChanged, this, &MpvVideoItem::updateNativeHostWindow);
    connect(this, &QQuickItem::windowChanged, this, [this](QQuickWindow*) {
        updateNativeHostWindow();
    });

    const QString backend = SettingsComponent::Get().value(SETTINGS_SECTION_MPV, "renderBackend").toString();
    m_nativeGpuNext = shouldUseNativeGpuNext(backend);
#if defined(Q_OS_MAC)
    if (m_nativeGpuNext)
        qInfo() << "Using a separate macOS GPU-Next playback window";
#endif
    setNativeVideoOutput(m_nativeGpuNext);

    if (!m_nativeGpuNext) {
        // Critical: Render-API integration requires vo=libmpv.
        Q_EMIT setProperty("vo", "libmpv");

#ifdef Q_OS_WIN32
        Q_EMIT setProperty("gpu-api", "opengl");
        Q_EMIT setProperty("opengl-es", "no");
#endif
    }
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
    default:
        break;
    }

    return MpvAbstractItem::eventFilter(watched, event);
}

void MpvVideoItem::updateNativeHostWindow()
{
    if (!m_nativeHostWindow)
        return;

    const QPointF scenePosition = mapToScene(QPointF(0.0, 0.0));
    const QRect geometry(qRound(scenePosition.x()), qRound(scenePosition.y()),
                         qMax(1, qRound(width())), qMax(1, qRound(height())));
    if (m_nativeHostWindow->geometry() != geometry)
        m_nativeHostWindow->setGeometry(geometry);

    const bool shouldShow = isVisible() && width() > 0.0 && height() > 0.0;
    if (shouldShow) {
        m_nativeHostWindow->show();
        m_nativeHostWindow->raise();
        m_nativeHostWindow->requestActivate();
    } else {
        // This is intentionally synchronous with QML's visible binding.  mpv
        // can finish tearing down its own child later without touching the
        // WebEngine surface that is about to become visible again.
        m_nativeHostWindow->hide();
    }
}

void MpvVideoItem::initializeController()
{
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
        commandAsync({QStringLiteral("cycle"), QStringLiteral("pause")});
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
    QString wheel;
    int amount = 0;
    if (qAbs(delta.y()) >= qAbs(delta.x())) {
        wheel = delta.y() >= 0 ? QStringLiteral("WHEEL_UP") : QStringLiteral("WHEEL_DOWN");
        amount = qAbs(delta.y());
    } else {
        wheel = delta.x() >= 0 ? QStringLiteral("WHEEL_RIGHT") : QStringLiteral("WHEEL_LEFT");
        amount = qAbs(delta.x());
    }
    const double scale = qMax(1.0, amount / 120.0);
    commandAsync({QStringLiteral("keypress"), wheel, QString::number(scale, 'f', 3)});
    event->accept();
}

void MpvVideoItem::keyPressEvent(QKeyEvent* event)
{
    if (event->isAutoRepeat()) {
        event->accept();
        return;
    }

    // System mpv roots frequently ship their own profile-menu script. Route
    // the three user-facing Tigerest shortcuts directly to namespaced
    // companion profiles so they work in both embedded and system mode.
    if (event->modifiers() == Qt::AltModifier &&
        event->key() >= Qt::Key_1 && event->key() <= Qt::Key_3) {
        QString profile;
        QString displayName;
        int expectedShaders = 0;
        switch (event->key()) {
        case Qt::Key_1:
            profile = QStringLiteral("tigerest-default");
            displayName = QStringLiteral("默认");
            expectedShaders = 3;
            break;
        case Qt::Key_2:
            profile = QStringLiteral("tigerest-liveaction");
            displayName = QStringLiteral("真人");
            expectedShaders = 2;
            break;
        case Qt::Key_3:
            profile = QStringLiteral("tigerest-aggressive-test");
            displayName = QStringLiteral("激进测试");
            expectedShaders = 4;
            break;
        default:
            break;
        }

        // List-valued options in runtime-applied mpv profiles are additive. Use
        // mpv's list operation so repeated Alt switches cannot accumulate
        // shaders from the previously selected profile.
        const QVariant clearResult = commandBlocking(QStringList{
            QStringLiteral("change-list"), QStringLiteral("glsl-shaders"),
            QStringLiteral("clr"), QString()});
        const QVariant result = commandBlocking(QStringList{QStringLiteral("apply-profile"), profile});
        const bool commandOk = clearResult.metaType() != QMetaType::fromType<ErrorReturn>() &&
            result.metaType() != QMetaType::fromType<ErrorReturn>();
        const QVariant shaders = getProperty(QStringLiteral("glsl-shaders"));
        int shaderCount = 0;
        for (const QVariant& shader : shaders.toList()) {
            if (!shader.toString().trimmed().isEmpty())
                ++shaderCount;
        }
        const bool shaderStateOk = shaderCount == expectedShaders;
        const QString message = commandOk && shaderStateOk
            ? QStringLiteral("已切换滤镜: %1（%2 个 shader）").arg(displayName).arg(shaderCount)
            : QStringLiteral("滤镜切换失败: %1（实际 %2 个 shader）").arg(displayName).arg(shaderCount);
        setPropertyBlocking(QStringLiteral("user-data/profile_menu/current"), profile);
        commandAsync({QStringLiteral("show-text"), message, QStringLiteral("2400")});
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
        commandAsync({QStringLiteral("cycle"), QStringLiteral("pause")});
        event->accept();
        return;
    }

    const QString key = keyName(event);
    if (!key.isEmpty())
        commandAsync({QStringLiteral("keydown"), key});
    event->accept();
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
