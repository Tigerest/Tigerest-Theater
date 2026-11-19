#include "MpvVideoItem.h"

#include <QDebug>
#include <QQuickWindow>
#include <QWindow>

#import <AppKit/AppKit.h>
#import <Carbon/Carbon.h>
#import <objc/runtime.h>
#include <algorithm>

namespace
{
QString mpvKeyName(NSEvent* event)
{
    QString key;
    switch (event.keyCode) {
    case kVK_Space: key = "SPACE"; break;
    case kVK_Return: key = "ENTER"; break;
    case kVK_Escape: key = "ESC"; break;
    case kVK_Delete: key = "BS"; break;
    case kVK_ForwardDelete: key = "DEL"; break;
    case kVK_Tab: key = "TAB"; break;
    case kVK_LeftArrow: key = "LEFT"; break;
    case kVK_RightArrow: key = "RIGHT"; break;
    case kVK_UpArrow: key = "UP"; break;
    case kVK_DownArrow: key = "DOWN"; break;
    case kVK_Home: key = "HOME"; break;
    case kVK_End: key = "END"; break;
    case kVK_PageUp: key = "PGUP"; break;
    case kVK_PageDown: key = "PGDWN"; break;
    case kVK_Help: key = "INS"; break;
    case kVK_F1: key = "F1"; break;
    case kVK_F2: key = "F2"; break;
    case kVK_F3: key = "F3"; break;
    case kVK_F4: key = "F4"; break;
    case kVK_F5: key = "F5"; break;
    case kVK_F6: key = "F6"; break;
    case kVK_F7: key = "F7"; break;
    case kVK_F8: key = "F8"; break;
    case kVK_F9: key = "F9"; break;
    case kVK_F10: key = "F10"; break;
    case kVK_F11: key = "F11"; break;
    case kVK_F12: key = "F12"; break;
    case kVK_F13: key = "F13"; break;
    case kVK_F14: key = "F14"; break;
    case kVK_F15: key = "F15"; break;
    case kVK_F16: key = "F16"; break;
    case kVK_F17: key = "F17"; break;
    case kVK_F18: key = "F18"; break;
    case kVK_F19: key = "F19"; break;
    case kVK_F20: key = "F20"; break;
    case kVK_ANSI_KeypadEnter: key = "KP_ENTER"; break;
    case kVK_ANSI_KeypadDecimal: key = "KP_DEC"; break;
    case kVK_ANSI_KeypadPlus: key = "KP_ADD"; break;
    case kVK_ANSI_KeypadMinus: key = "KP_SUBTRACT"; break;
    case kVK_ANSI_KeypadMultiply: key = "KP_MULTIPLY"; break;
    case kVK_ANSI_KeypadDivide: key = "KP_DIVIDE"; break;
    case kVK_ANSI_Keypad0: key = "KP0"; break;
    case kVK_ANSI_Keypad1: key = "KP1"; break;
    case kVK_ANSI_Keypad2: key = "KP2"; break;
    case kVK_ANSI_Keypad3: key = "KP3"; break;
    case kVK_ANSI_Keypad4: key = "KP4"; break;
    case kVK_ANSI_Keypad5: key = "KP5"; break;
    case kVK_ANSI_Keypad6: key = "KP6"; break;
    case kVK_ANSI_Keypad7: key = "KP7"; break;
    case kVK_ANSI_Keypad8: key = "KP8"; break;
    case kVK_ANSI_Keypad9: key = "KP9"; break;
    default:
        // Cocoa preserves Shift here, but removes Ctrl/Option/Command. Use the
        // resulting Unicode character so layout, case and punctuation survive.
        key = QString::fromNSString(event.charactersIgnoringModifiers);
        const auto characters = key.toUcs4();
        if (characters.size() != 1 || !QChar::isPrint(characters.front()))
            return {};
        break;
    }

    QStringList modifiers;
    if (event.modifierFlags & NSEventModifierFlagControl) modifiers << "Ctrl";
    if (event.modifierFlags & NSEventModifierFlagOption) modifiers << "Alt";
    if (event.modifierFlags & NSEventModifierFlagCommand) modifiers << "Meta";
    // Shift is already represented by printable text (e.g. A or !).
    if ((event.modifierFlags & NSEventModifierFlagShift) && key.toUcs4().size() != 1)
        modifiers << "Shift";
    modifiers << key;
    return modifiers.join('+');
}

bool isMpvWindow(NSWindow* window)
{
    if (!window)
        return false;

    // mpv's Swift module name varies between builds (for example "swift").
    // Identify its NSWindow by the loaded library that implements the class,
    // so Qt library/search windows and native system dialogs are left alone.
    const char* image = class_getImageName(window.class);
    return image && [[[NSString stringWithUTF8String:image] lastPathComponent]
                     hasPrefix:@"libmpv."];
}
}

namespace
{
// mpv's playback window: the visible one, else any of its windows.
NSWindow* playbackWindow()
{
    for (NSWindow* window in NSApp.windows)
        if (isMpvWindow(window) && window.isVisible)
            return window;
    for (NSWindow* window in NSApp.windows)
        if (isMpvWindow(window))
            return window;
    return nil;
}

NSWindow* cocoaWindow(QWindow* window)
{
    if (!window)
        return nil;
    NSView* view = (__bridge NSView*)reinterpret_cast<void*>(window->winId());
    return view.window;
}

// Qt's global coordinates have their origin at the top left of the primary
// screen, Cocoa's at its bottom left; both count points.
NSRect cocoaRect(const QRectF& rect)
{
    const CGFloat height = NSScreen.screens.firstObject.frame.size.height;
    return NSMakeRect(rect.x(), height - rect.y() - rect.height(), rect.width(), rect.height());
}

QRectF qtRect(NSRect rect)
{
    const CGFloat height = NSScreen.screens.firstObject.frame.size.height;
    return QRectF(rect.origin.x, height - rect.origin.y - rect.size.height, rect.size.width, rect.size.height);
}
}

// Fullscreen transitions in progress in this application: AppKit runs one
// at a time, and a window shown or attached during one stays where it was.
// A transition that fails sends no notification; three seconds end it.
static int g_fullScreenTransitions = 0;
static CFAbsoluteTime g_fullScreenTransitionStarted = 0;
static void observeFullScreenTransitions()
{
    static bool observing = false;
    if (observing)
        return;
    observing = true;
    NSNotificationCenter* center = NSNotificationCenter.defaultCenter;
    for (NSNotificationName name in @[NSWindowWillEnterFullScreenNotification, NSWindowWillExitFullScreenNotification])
        [center addObserverForName:name object:nil queue:nil usingBlock:^(NSNotification*) {
            g_fullScreenTransitions++;
            g_fullScreenTransitionStarted = CFAbsoluteTimeGetCurrent();
        }];
    for (NSNotificationName name in @[NSWindowDidEnterFullScreenNotification, NSWindowDidExitFullScreenNotification])
        [center addObserverForName:name object:nil queue:nil usingBlock:^(NSNotification*) {
            g_fullScreenTransitions = std::max(0, g_fullScreenTransitions - 1);
        }];
}

bool MpvVideoItem::macFullScreenTransitionActive()
{
    observeFullScreenTransitions();
    if (g_fullScreenTransitions > 0 && CFAbsoluteTimeGetCurrent() - g_fullScreenTransitionStarted > 3)
        g_fullScreenTransitions = 0;
    return g_fullScreenTransitions > 0;
}

bool MpvVideoItem::macWindowFullScreen(QWindow* window)
{
    NSWindow* native = cocoaWindow(window);
    return native && (native.styleMask & NSWindowStyleMaskFullScreen);
}

bool MpvVideoItem::macPlaybackWindowAttached()
{
    NSWindow* window = playbackWindow();
    return window && window.parentWindow != nil;
}

bool MpvVideoItem::macPlaybackWindowFullScreen() const
{
    NSWindow* window = playbackWindow();
    return window && (window.styleMask & NSWindowStyleMaskFullScreen);
}

QRect MpvVideoItem::macPlaybackWindowGeometry() const
{
    NSWindow* window = playbackWindow();
    if (!window || !window.isVisible)
        return {};
    return qtRect([window contentRectForFrameRect:window.frame]).toRect();
}

void MpvVideoItem::setMacProAttached(bool attached)
{
    if (attached == m_macProAttached) {
        if (attached)
            updateMacProFrame();
        return;
    }
    if (attached) {
        NSWindow* video = playbackWindow();
        NSWindow* parent = cocoaWindow(window());
        if (!video || !parent || video == parent) {
            qWarning() << "Professional mode: no playback window to attach";
            return;
        }
        const NSRect frame = video.frame;
        m_macProSavedFrame = QRectF(frame.origin.x, frame.origin.y, frame.size.width, frame.size.height);
        m_macProSavedStyle = video.styleMask;
        m_macProSavedBehavior = video.collectionBehavior;
        // A borderless child follows the page's window, also into its
        // fullscreen Space, and never enters fullscreen on its own.
        video.styleMask = NSWindowStyleMaskBorderless;
        video.collectionBehavior = (video.collectionBehavior & ~NSWindowCollectionBehaviorFullScreenPrimary) |
                                   NSWindowCollectionBehaviorFullScreenAuxiliary;
        [parent addChildWindow:video ordered:NSWindowAbove];
        m_macProWindow = (__bridge_retained void*)video;
        m_macProParent = (__bridge_retained void*)parent;
        m_macProAttached = true;
        updateMacProFrame();
        qInfo() << "Professional mode: playback window attached to the page";
        return;
    }
    NSWindow* video = (__bridge_transfer NSWindow*)m_macProWindow;
    NSWindow* parent = (__bridge_transfer NSWindow*)m_macProParent;
    m_macProWindow = nullptr;
    m_macProParent = nullptr;
    m_macProAttached = false;
    if (parent && video)
        [parent removeChildWindow:video];
    if (video) {
        video.styleMask = (NSWindowStyleMask)m_macProSavedStyle;
        video.collectionBehavior = (NSWindowCollectionBehavior)m_macProSavedBehavior;
        [video setFrame:NSMakeRect(m_macProSavedFrame.x(), m_macProSavedFrame.y(),
                                   m_macProSavedFrame.width(), m_macProSavedFrame.height())
                display:YES];
        qInfo() << "Professional mode: playback window detached";
    }
}

void MpvVideoItem::updateMacProFrame()
{
    if (!m_macProAttached || !window())
        return;
    NSWindow* video = (__bridge NSWindow*)m_macProWindow;
    const QRectF rect(mapToGlobal(QPointF(0, 0)), QSizeF(qMax<qreal>(1, width()), qMax<qreal>(1, height())));
    const NSRect frame = NSIntegralRect(cocoaRect(rect));
    if (!NSEqualRects(video.frame, frame)) {
        [video setFrame:frame display:YES];
        qDebug() << "Professional mode: video area" << rect << "frame" << NSStringFromRect(frame).UTF8String
                 << "now" << NSStringFromRect(video.frame).UTF8String;
    }
}

void MpvVideoItem::installMacInputMonitor()
{
    if (m_macInputMonitor)
        return;

    // libmpv disables default bindings in system-config mode unless opted in.
    // Keep the host's basic shortcuts available without replacing explicit
    // user bindings. Normal bindings still yield to UOSC's forced menu keys.
    const QVariantList bindings = getProperty(QStringLiteral("input-bindings")).toList();
    const QHash<QString, QString> fallbacks{
        {QStringLiteral("SPACE"), QStringLiteral("cycle pause")},
        {QStringLiteral("F11"), QStringLiteral("cycle fullscreen")},
    };
    for (auto fallback = fallbacks.cbegin(); fallback != fallbacks.cend(); ++fallback) {
        bool bound = false;
        for (const QVariant& value : bindings) {
            const QVariantMap binding = value.toMap();
            if (binding.value(QStringLiteral("key")).toString() == fallback.key() &&
                binding.value(QStringLiteral("priority")).toInt() >= 0) {
                bound = true;
                break;
            }
        }
        if (!bound)
            commandAsync({QStringLiteral("keybind"), fallback.key(), fallback.value()});
    }

    __block bool doubleClickDown = false;
    const NSEventMask mask = NSEventMaskKeyDown | NSEventMaskKeyUp |
                             NSEventMaskLeftMouseDown | NSEventMaskLeftMouseUp;
    id monitor = [NSEvent addLocalMonitorForEventsMatchingMask:mask handler:^NSEvent*(NSEvent* event) {
        if (!m_nativeGpuNext || !isVisible() || NSApp.modalWindow || !isMpvWindow(event.window)) {
            releaseMacKeys();
            doubleClickDown = false;
            return event;
        }

        // libmpv's Cocoa window has no keyDown handler: the standalone mpv
        // Application normally dispatches keys, but here Qt owns NSApplication.
        // Forward through mpv's bindings so forced UOSC menu/search bindings
        // take priority over playback shortcuts, including Space and Escape.
        if (event.type == NSEventTypeKeyUp) {
            const QString key = m_macPressedKeys.take(event.keyCode);
            if (!key.isEmpty()) {
                commandAsync({QStringLiteral("keyup"), key});
                return nil;
            }
            return event;
        }
        if (event.type == NSEventTypeKeyDown) {
            // mpv owns repeat timing after keydown. Cocoa repeats must not
            // toggle non-repeatable commands such as pause multiple times.
            if (event.isARepeat || m_macPressedKeys.contains(event.keyCode))
                return nil;
            if ((event.modifierFlags & NSEventModifierFlagCommand) &&
                [NSApp.mainMenu performKeyEquivalent:event])
                return nil;
            const QString key = mpvKeyName(event);
            if (key.isEmpty())
                return event;
            m_macPressedKeys.insert(event.keyCode, key);
            commandAsync({QStringLiteral("keydown"), key});
            return nil;
        }

        // input.conf suppresses mpv's own double-click action because the Qt
        // host handles it. The separate Cocoa window needs the same treatment:
        // consume the second press AND release to avoid duplicate mpv/UOSC input.
        if (event.type == NSEventTypeLeftMouseDown && event.clickCount == 2) {
            NSView* content = event.window.contentView;
            const NSPoint point = [content convertPoint:event.locationInWindow fromView:nil];
            if (NSPointInRect(point, content.bounds)) {
                doubleClickDown = true;
                togglePause();
                return nil;
            }
        }
        if (event.type == NSEventTypeLeftMouseUp && doubleClickDown) {
            doubleClickDown = false;
            return nil;
        }
        return event;
    }];
    m_macInputMonitor = (__bridge_retained void*)monitor;
    id observer = [NSNotificationCenter.defaultCenter addObserverForName:NSWindowDidResignKeyNotification
        object:nil queue:nil usingBlock:^(NSNotification* notification) {
            if (isMpvWindow(notification.object)) {
                releaseMacKeys();
                doubleClickDown = false;
            }
        }];
    m_macInputFocusObserver = (__bridge_retained void*)observer;
    connect(this, &QQuickItem::visibleChanged, this, [this]() {
        if (!isVisible())
            releaseMacKeys();
    });
}

void MpvVideoItem::releaseMacKeys()
{
    if (m_macPressedKeys.isEmpty())
        return;
    // Some libmpv builds crash on a keyup command with its optional name
    // omitted. Explicit names also limit cleanup to keys owned by this bridge.
    for (const QString& key : m_macPressedKeys)
        commandAsync({QStringLiteral("keyup"), key});
    m_macPressedKeys.clear();
}

void MpvVideoItem::removeMacInputMonitor()
{
    if (!m_macInputMonitor)
        return;
    releaseMacKeys();
    id observer = (__bridge_transfer id)m_macInputFocusObserver;
    m_macInputFocusObserver = nullptr;
    [NSNotificationCenter.defaultCenter removeObserver:observer];
    id monitor = (__bridge_transfer id)m_macInputMonitor;
    m_macInputMonitor = nullptr;
    [NSEvent removeMonitor:monitor];
}
