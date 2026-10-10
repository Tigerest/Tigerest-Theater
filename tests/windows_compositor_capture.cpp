// Test-only observer of the displayed client area. No Qt/WebEngine re-render,
// GPU fence or texture readback is inserted into the application under test.
#include <windows.h>
#include <tlhelp32.h>
#include <QCoreApplication>
#include <QElapsedTimer>
#include <QFile>
#include <QDir>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QThread>
#include <cstdio>
#include "compositor_frame_check.h"

struct Target { DWORD pid; HWND window = nullptr; qint64 area = 0; };
BOOL CALLBACK findWindow(HWND window, LPARAM data) {
  auto &target = *reinterpret_cast<Target *>(data);
  DWORD pid = 0;
  GetWindowThreadProcessId(window, &pid);
  if (pid != target.pid || !IsWindowVisible(window) || IsIconic(window) || GetWindow(window, GW_OWNER))
    return TRUE;
  RECT rect{};
  if (GetClientRect(window, &rect)) {
    const qint64 area = qint64(rect.right) * rect.bottom;
    if (area > target.area) { target.window = window; target.area = area; }
  }
  return TRUE;
}

int main(int argc, char **argv) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  QCoreApplication app(argc, argv);
  const auto args = app.arguments();
  if (args.size() != 6) return 2; // pid, JSON specification, output, duration ms, interval ms
  QFile specFile(args[2]);
  if (!specFile.open(QIODevice::ReadOnly)) return 2;
  const auto spec = QJsonDocument::fromJson(specFile.readAll()).object();
  Target target{args[1].toULong()};
  EnumWindows(findWindow, reinterpret_cast<LPARAM>(&target));
  QJsonObject report{{"pid", int(target.pid)}, {"frames", 0}, {"damagedFrames", 0}};
  QString error;
  QString webEngineCore;
  const HANDLE moduleSnapshot = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, target.pid);
  if (moduleSnapshot != INVALID_HANDLE_VALUE) {
    MODULEENTRY32W module{};
    module.dwSize = sizeof(module);
    if (Module32FirstW(moduleSnapshot, &module)) {
      do {
        if (QString::fromWCharArray(module.szModule).compare("Qt6WebEngineCore.dll", Qt::CaseInsensitive) == 0) {
          webEngineCore = QString::fromWCharArray(module.szExePath);
          break;
        }
      } while (Module32NextW(moduleSnapshot, &module));
    }
    CloseHandle(moduleSnapshot);
  }
  if (webEngineCore.isEmpty()) error = "Cannot identify the actual loaded WebEngine core DLL";
  report["webEngineCore"] = webEngineCore;
  const int duration = args[4].toInt(), interval = args[5].toInt();
  if (!target.window || target.area == 0 || duration < 0 || duration > 60000 || interval < 10 ||
      spec["samples"].toArray().isEmpty()) error = "Missing visible window, samples or invalid duration";
  const QString directory = args[3];
  if (!QDir().mkpath(directory)) error = "Cannot create capture evidence directory";
  QVector<CompositorSample> samples;
  int frames = 0, damaged = 0;
  QElapsedTimer timer;
  timer.start();
  while (error.isEmpty()) {
    DWORD foregroundPid = 0;
    GetWindowThreadProcessId(GetForegroundWindow(), &foregroundPid);
    if (foregroundPid != target.pid || IsIconic(target.window)) {
      error = "Fixture is not the foreground visible window; capture is invalid";
      break;
    }
    RECT client{};
    POINT origin{};
    if (!GetClientRect(target.window, &client) || !ClientToScreen(target.window, &origin)) {
      error = "Cannot determine actual client rectangle"; break;
    }
    const int width = client.right, height = client.bottom;
    const qreal scale = spec["dpr"].toDouble();
    const int contentHeight = qRound(spec["height"].toDouble() * scale);
    const int top = height - contentHeight;
    if (scale <= 0 || qAbs(width - spec["width"].toDouble() * scale) > 2 || top < 0 || top > 150) {
      error = "Viewport/client size changed; sample coordinates are invalid"; break;
    }
    samples.clear();
    for (const auto entry : spec["samples"].toArray()) {
      const auto value = entry.toObject();
      QRect rect(qRound(value["x"].toDouble() * scale), top + qRound(value["y"].toDouble() * scale),
                 qMax(1, qRound(value["width"].toDouble() * scale)),
                 qMax(1, qRound(value["height"].toDouble() * scale)));
      const POINT center{origin.x + rect.center().x(), origin.y + rect.center().y()};
      DWORD visiblePid = 0;
      GetWindowThreadProcessId(WindowFromPoint(center), &visiblePid);
      if (visiblePid != target.pid) { error = "Sample is occluded or outside the visible desktop"; break; }
      samples.append({value["name"].toString(), rect, QColor(value["color"].toString())});
    }
    if (!error.isEmpty()) break;
    HDC desktop = GetDC(nullptr);
    HDC memory = CreateCompatibleDC(desktop);
    BITMAPINFO info{};
    info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    info.bmiHeader.biWidth = width;
    info.bmiHeader.biHeight = -height;
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB;
    void *bits = nullptr;
    HBITMAP bitmap = CreateDIBSection(desktop, &info, DIB_RGB_COLORS, &bits, nullptr, 0);
    HGDIOBJ old = bitmap ? SelectObject(memory, bitmap) : nullptr;
    QImage frame;
    if (bits && BitBlt(memory, 0, 0, width, height, desktop, origin.x, origin.y, SRCCOPY | CAPTUREBLT)) {
      GdiFlush();
      frame = QImage(static_cast<const uchar *>(bits), width, height, QImage::Format_RGB32).copy();
    }
    if (old) SelectObject(memory, old);
    if (bitmap) DeleteObject(bitmap);
    if (memory) DeleteDC(memory);
    if (desktop) ReleaseDC(nullptr, desktop);
    if (frame.isNull()) { error = "Displayed client capture failed"; break; }
    ++frames;
    const auto errors = checkCompositorFrame(frame, samples);
    if (!errors.isEmpty()) {
      ++damaged;
      if (damaged <= 5) {
        const QString filename = QString("failed-%1.png").arg(frames, 5, 10, QLatin1Char('0'));
        if (!frame.save(QDir(directory).filePath(filename))) { error = "Cannot save failed frame"; break; }
        QFile detail(QDir(directory).filePath(filename + ".json"));
        if (!detail.open(QIODevice::WriteOnly)) { error = "Cannot save pixel failure details"; break; }
        detail.write(QJsonDocument(QJsonObject{{"elapsedMs", int(timer.elapsed())},
            {"errors", QJsonArray::fromStringList(errors)}}).toJson());
      }
    } else if (frames == 1) {
      if (!frame.save(QDir(directory).filePath("first-valid.png"))) { error = "Cannot save valid frame"; break; }
    }
    if (timer.elapsed() >= duration) break;
    QThread::msleep(interval);
  }
  report["frames"] = frames;
  report["damagedFrames"] = damaged;
  report["elapsedMs"] = int(timer.elapsed());
  report["samples"] = samples.size();
  report["error"] = error;
  const QByteArray json = QJsonDocument(report).toJson(QJsonDocument::Compact);
  std::puts(json.constData());
  return error.isEmpty() && frames > 0 && damaged == 0 ? 0 : 1;
}
