#ifndef WINDOWSHDR_H
#define WINDOWSHDR_H

#include <QString>

#include <functional>

// Windows HDR ("Use HDR") state and exact refresh rate of the display that
// shows a window, through the DisplayConfig API. Displays are identified by their monitor device path,
// which, unlike \\.\DISPLAYn, survives reboots and reconnects.
namespace WindowsHdr
{
  struct Display
  {
    QString devicePath;
    QString name;
    bool supported = false;
    bool enabled = false;
    // Exact rational rate (e.g. 59.997 or 119.88); DEVMODE only has whole hertz.
    double refreshRate = 0;
  };

  // The display under the largest part of the window; empty path if unknown.
  Display forWindow(quintptr hwnd);
  Display byDevicePath(const QString& devicePath);
  // Blocks while the display changes mode (about a second).
  bool setEnabled(const QString& devicePath, bool enabled);
}

// Turns Windows HDR on for HDR media and back off afterwards. Only a switch
// this class made is undone; a marker file lets the next launch undo one that
// a crash or forced exit left behind.
class WindowsHdrSwitch
{
public:
  struct Backend
  {
    std::function<WindowsHdr::Display(quintptr)> forWindow = WindowsHdr::forWindow;
    std::function<WindowsHdr::Display(const QString&)> byDevicePath = WindowsHdr::byDevicePath;
    std::function<bool(const QString&, bool)> setEnabled = WindowsHdr::setEnabled;
  };
  struct Result
  {
    bool switched = false;  // the display changed mode; wait before opening video
    bool hdrActive = false; // the window's display is in HDR mode for this item
  };

  explicit WindowsHdrSwitch(const QString& markerFile, Backend backend = Backend());
  // Before each load: HDR on for HDR media (when allowed), back off for SDR media.
  Result prepare(quintptr hwnd, bool hdrSource, bool allowed);
  bool restore();
  // At startup: undo a switch an earlier run did not restore.
  bool recover();
  QString ownedDevice() const { return m_owned; }

private:
  QString m_markerFile;
  Backend m_backend;
  QString m_owned;
};

#endif // WINDOWSHDR_H
