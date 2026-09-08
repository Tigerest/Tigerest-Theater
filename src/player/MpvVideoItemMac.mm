#include "MpvVideoItem.h"

#import <AppKit/AppKit.h>
#import <objc/runtime.h>

namespace
{
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

void MpvVideoItem::installMacInputMonitor()
{
    if (m_macInputMonitor)
        return;

    __block bool spaceDown = false;
    __block bool doubleClickDown = false;
    const NSEventMask mask = NSEventMaskKeyDown | NSEventMaskKeyUp |
                             NSEventMaskLeftMouseDown | NSEventMaskLeftMouseUp;
    id monitor = [NSEvent addLocalMonitorForEventsMatchingMask:mask handler:^NSEvent*(NSEvent* event) {
        if (!m_nativeGpuNext || !isVisible() || NSApp.modalWindow || !isMpvWindow(event.window)) {
            spaceDown = false;
            doubleClickDown = false;
            return event;
        }

        // libmpv's Cocoa window has no keyDown handler: the standalone mpv
        // Application normally dispatches keys, but here Qt owns NSApplication.
        // Mirror the Qt item's pause shortcut once, including its key-up guard.
        if (event.type == NSEventTypeKeyUp && event.keyCode == 49 && spaceDown) {
            spaceDown = false;
            return nil;
        }
        const NSEventModifierFlags modifiers = NSEventModifierFlagCommand | NSEventModifierFlagControl |
                                              NSEventModifierFlagOption | NSEventModifierFlagShift;
        if (event.type == NSEventTypeKeyDown && event.keyCode == 49 && !(event.modifierFlags & modifiers)) {
            if (!event.isARepeat) {
                spaceDown = true;
                commandAsync({QStringLiteral("cycle"), QStringLiteral("pause")});
            }
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
                commandAsync({QStringLiteral("cycle"), QStringLiteral("pause")});
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
}

void MpvVideoItem::removeMacInputMonitor()
{
    if (!m_macInputMonitor)
        return;
    id monitor = (__bridge_transfer id)m_macInputMonitor;
    m_macInputMonitor = nullptr;
    [NSEvent removeMonitor:monitor];
}
