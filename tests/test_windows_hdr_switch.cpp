// Windows HDR switching policy against a fake display; the real display is
// never touched.
#include <QtTest>
#include <QTemporaryDir>

#include <windows.h>

#include <cmath>

#include "display/win/WindowsHdr.h"

class TestWindowsHdrSwitch : public QObject
{
  Q_OBJECT

  struct Fake
  {
    WindowsHdr::Display display{"\\\\?\\DISPLAY#MSI#1", "MPG272UX OLED", true, false};
    QStringList calls;
    bool fail = false;

    WindowsHdrSwitch::Backend backend()
    {
      WindowsHdrSwitch::Backend b;
      b.forWindow = [this](quintptr) { return display; };
      b.byDevicePath = [this](const QString& path) { return path == display.devicePath ? display : WindowsHdr::Display(); };
      b.setEnabled = [this](const QString& path, bool on) {
        calls << (on ? "on " : "off ") + path;
        if (fail || path != display.devicePath)
          return false;
        display.enabled = on;
        return true;
      };
      return b;
    }
  };

  QTemporaryDir m_dir;
  QString marker() const { return m_dir.filePath("windows-hdr-restore.txt"); }

private Q_SLOTS:
  void init()
  {
    QFile::remove(marker());
  }

  void hdrMediaTurnsHdrOnAndRestoreTurnsItOff()
  {
    Fake fake;
    WindowsHdrSwitch hdr(marker(), fake.backend());
    auto result = hdr.prepare(1, true, true);
    QVERIFY(result.switched);
    QVERIFY(result.hdrActive);
    QVERIFY(fake.display.enabled);
    QVERIFY(QFile::exists(marker()));
    // The next HDR episode keeps the mode without another switch.
    result = hdr.prepare(1, true, true);
    QVERIFY(!result.switched);
    QVERIFY(result.hdrActive);
    QVERIFY(hdr.restore());
    QVERIFY(!fake.display.enabled);
    QVERIFY(!QFile::exists(marker()));
    QCOMPARE(fake.calls.size(), 2);
  }

  void sdrMediaAfterHdrMediaRestoresSdr()
  {
    Fake fake;
    WindowsHdrSwitch hdr(marker(), fake.backend());
    hdr.prepare(1, true, true);
    const auto result = hdr.prepare(1, false, true);
    QVERIFY(result.switched);
    QVERIFY(!result.hdrActive);
    QVERIFY(!fake.display.enabled);
  }

  void userHdrIsNeverTurnedOff()
  {
    Fake fake;
    fake.display.enabled = true;
    WindowsHdrSwitch hdr(marker(), fake.backend());
    auto result = hdr.prepare(1, true, true);
    QVERIFY(!result.switched);
    QVERIFY(result.hdrActive);
    result = hdr.prepare(1, false, true);
    QVERIFY(!result.switched);
    // SDR media on a display the user keeps in HDR mode: still HDR output, no ICC.
    QVERIFY(result.hdrActive);
    QVERIFY(!hdr.restore());
    QVERIFY(fake.display.enabled);
    QVERIFY(fake.calls.isEmpty());
  }

  void disabledOrUnsupportedDisplayIsLeftAlone()
  {
    Fake fake;
    WindowsHdrSwitch hdr(marker(), fake.backend());
    QVERIFY(!hdr.prepare(1, true, false).switched);
    fake.display.supported = false;
    QVERIFY(!hdr.prepare(1, true, true).switched);
    QVERIFY(fake.calls.isEmpty());
    QVERIFY(!QFile::exists(marker()));
  }

  void failedSwitchLeavesNoMarker()
  {
    Fake fake;
    fake.fail = true;
    WindowsHdrSwitch hdr(marker(), fake.backend());
    const auto result = hdr.prepare(1, true, true);
    QVERIFY(!result.switched);
    QVERIFY(!result.hdrActive);
    QVERIFY(!QFile::exists(marker()));
    QVERIFY(hdr.ownedDevice().isEmpty());
  }

  void nextLaunchUndoesALeftoverSwitch()
  {
    Fake fake;
    {
      WindowsHdrSwitch crashed(marker(), fake.backend());
      crashed.prepare(1, true, true);
    }
    QVERIFY(fake.display.enabled);
    WindowsHdrSwitch next(marker(), fake.backend());
    QVERIFY(next.recover());
    QVERIFY(!fake.display.enabled);
    QVERIFY(!QFile::exists(marker()));
    QVERIFY(!next.recover());
  }

  void systemQueryFindsThisProcessDisplay()
  {
    // Read-only: the desktop window's display must resolve to a device path.
    const auto display = WindowsHdr::forWindow(reinterpret_cast<quintptr>(GetDesktopWindow()));
    QVERIFY2(!display.devicePath.isEmpty(), "no display path for the primary monitor");
    QCOMPARE(WindowsHdr::byDevicePath(display.devicePath).devicePath, display.devicePath);
  }

  void systemQueryReportsTheExactRefreshRate()
  {
    // The rational rate refines DEVMODE's whole hertz (59 or 60 for 59.94).
    const HWND desktop = GetDesktopWindow();
    MONITORINFOEXW monitor{};
    monitor.cbSize = sizeof(monitor);
    QVERIFY(GetMonitorInfoW(MonitorFromWindow(desktop, MONITOR_DEFAULTTOPRIMARY), &monitor));
    DEVMODEW mode{};
    mode.dmSize = sizeof(mode);
    QVERIFY(EnumDisplaySettingsW(monitor.szDevice, ENUM_CURRENT_SETTINGS, &mode));
    const double exact = WindowsHdr::forWindow(reinterpret_cast<quintptr>(desktop)).refreshRate;
    QVERIFY2(exact > 0, "no rational refresh rate for the primary monitor");
    QVERIFY2(std::abs(exact - mode.dmDisplayFrequency) < 1,
             qPrintable(QString("%1 Hz vs DEVMODE %2 Hz").arg(exact).arg(mode.dmDisplayFrequency)));
  }
};

QTEST_GUILESS_MAIN(TestWindowsHdrSwitch)
#include "test_windows_hdr_switch.moc"
