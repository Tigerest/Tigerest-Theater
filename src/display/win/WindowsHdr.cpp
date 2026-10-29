#include "WindowsHdr.h"

#include <windows.h>

#include <QDebug>
#include <QFile>
#include <QSaveFile>
#include <QVector>

namespace
{
template<typename T>
T request(DISPLAYCONFIG_DEVICE_INFO_TYPE type, const LUID& adapter, UINT32 id)
{
  T info{};
  info.header.type = type;
  info.header.size = sizeof(T);
  info.header.adapterId = adapter;
  info.header.id = id;
  return info;
}

QVector<DISPLAYCONFIG_PATH_INFO> activePaths()
{
  UINT32 pathCount = 0, modeCount = 0;
  QVector<DISPLAYCONFIG_PATH_INFO> paths;
  QVector<DISPLAYCONFIG_MODE_INFO> modes;
  LONG result = ERROR_INSUFFICIENT_BUFFER;
  // The topology can change between the size query and the query itself.
  for (int attempt = 0; attempt < 3 && result == ERROR_INSUFFICIENT_BUFFER; ++attempt)
  {
    if (GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &pathCount, &modeCount) != ERROR_SUCCESS)
      return {};
    paths.resize(pathCount);
    modes.resize(modeCount);
    result = QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &pathCount, paths.data(), &modeCount, modes.data(), nullptr);
  }
  if (result != ERROR_SUCCESS)
    return {};
  paths.resize(pathCount);
  return paths;
}

WindowsHdr::Display describe(const DISPLAYCONFIG_PATH_INFO& path)
{
  WindowsHdr::Display display;
  auto name = request<DISPLAYCONFIG_TARGET_DEVICE_NAME>(DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME,
                                                        path.targetInfo.adapterId, path.targetInfo.id);
  if (DisplayConfigGetDeviceInfo(&name.header) != ERROR_SUCCESS)
    return display;
  display.devicePath = QString::fromWCharArray(name.monitorDevicePath);
  display.name = QString::fromWCharArray(name.monitorFriendlyDeviceName);
  const DISPLAYCONFIG_RATIONAL rate = path.targetInfo.refreshRate;
  if (rate.Denominator)
    display.refreshRate = double(rate.Numerator) / rate.Denominator;
  auto color = request<DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO>(DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO,
                                                              path.targetInfo.adapterId, path.targetInfo.id);
  if (DisplayConfigGetDeviceInfo(&color.header) == ERROR_SUCCESS)
  {
    // Automatic colour management on an SDR panel also reports "enabled",
    // with wide colour enforced; that is not HDR.
    display.supported = color.advancedColorSupported && !color.wideColorEnforced;
    display.enabled = display.supported && color.advancedColorEnabled;
  }
  return display;
}

const DISPLAYCONFIG_PATH_INFO* findPath(const QVector<DISPLAYCONFIG_PATH_INFO>& paths, const QString& devicePath)
{
  for (const auto& path : paths)
    if (!devicePath.isEmpty() && describe(path).devicePath == devicePath)
      return &path;
  return nullptr;
}
}

WindowsHdr::Display WindowsHdr::forWindow(quintptr hwnd)
{
  MONITORINFOEXW monitor{};
  monitor.cbSize = sizeof(monitor);
  HMONITOR handle = MonitorFromWindow(reinterpret_cast<HWND>(hwnd), MONITOR_DEFAULTTONEAREST);
  if (!handle || !GetMonitorInfoW(handle, &monitor))
    return {};
  for (const auto& path : activePaths())
  {
    auto source = request<DISPLAYCONFIG_SOURCE_DEVICE_NAME>(DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
                                                            path.sourceInfo.adapterId, path.sourceInfo.id);
    if (DisplayConfigGetDeviceInfo(&source.header) == ERROR_SUCCESS &&
        _wcsicmp(source.viewGdiDeviceName, monitor.szDevice) == 0)
      return describe(path);
  }
  return {};
}

WindowsHdr::Display WindowsHdr::byDevicePath(const QString& devicePath)
{
  const auto paths = activePaths();
  const auto* path = findPath(paths, devicePath);
  return path ? describe(*path) : Display();
}

bool WindowsHdr::setEnabled(const QString& devicePath, bool enabled)
{
  const auto paths = activePaths();
  const auto* path = findPath(paths, devicePath);
  if (!path)
    return false;
  auto state = request<DISPLAYCONFIG_SET_ADVANCED_COLOR_STATE>(DISPLAYCONFIG_DEVICE_INFO_SET_ADVANCED_COLOR_STATE,
                                                               path->targetInfo.adapterId, path->targetInfo.id);
  state.enableAdvancedColor = enabled;
  const LONG result = DisplayConfigSetDeviceInfo(&state.header);
  if (result != ERROR_SUCCESS)
    qWarning() << "Could not switch Windows HDR" << (enabled ? "on" : "off") << "error" << result;
  return result == ERROR_SUCCESS;
}

WindowsHdrSwitch::WindowsHdrSwitch(const QString& markerFile, Backend backend)
  : m_markerFile(markerFile), m_backend(std::move(backend))
{
}

WindowsHdrSwitch::Result WindowsHdrSwitch::prepare(quintptr hwnd, bool hdrSource, bool allowed)
{
  Result result;
  // SDR media after HDR media: undo our switch, wherever the window is now.
  if ((!hdrSource || !allowed) && !m_owned.isEmpty())
    result.switched = restore();
  WindowsHdr::Display display = m_backend.forWindow(hwnd);
  if (hdrSource && allowed && display.supported && !display.enabled && !display.devicePath.isEmpty())
  {
    // Record the switch first: a crash during the mode change must still be undone.
    QSaveFile marker(m_markerFile);
    if (marker.open(QIODevice::WriteOnly) && marker.write(display.devicePath.toUtf8()) > 0 && marker.commit())
    {
      qInfo() << "Turning on Windows HDR for HDR media on" << display.name;
      if (m_backend.setEnabled(display.devicePath, true))
      {
        m_owned = display.devicePath;
        result.switched = display.enabled = true;
      }
      else
        QFile::remove(m_markerFile);
    }
    else
      qWarning() << "Not turning on Windows HDR: cannot write" << m_markerFile;
  }
  result.hdrActive = display.enabled;
  return result;
}

bool WindowsHdrSwitch::restore()
{
  if (m_owned.isEmpty())
    return false;
  const WindowsHdr::Display display = m_backend.byDevicePath(m_owned);
  bool switched = false;
  if (display.enabled)
  {
    qInfo() << "Turning Windows HDR back off on" << display.name;
    switched = m_backend.setEnabled(m_owned, false);
  }
  m_owned.clear();
  QFile::remove(m_markerFile);
  return switched;
}

bool WindowsHdrSwitch::recover()
{
  QFile marker(m_markerFile);
  if (!marker.exists() || marker.size() > 4096 || !marker.open(QIODevice::ReadOnly))
    return false;
  m_owned = QString::fromUtf8(marker.readAll()).trimmed();
  marker.close();
  qWarning() << "Restoring Windows HDR left on by an earlier run";
  return restore();
}
