#include "SystemLoad.h"

#include <QHash>
#include <QString>

#include <algorithm>
#include <chrono>
#include <vector>

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <pdh.h>
#include <pdhmsg.h>

namespace
{
quint64 ticks(const FILETIME& time)
{
  return (quint64(time.dwHighDateTime) << 32) | time.dwLowDateTime;
}

struct ProcessorTimes
{
  quint64 idle = 0, busy = 0, self = 0;
  bool valid = false;
};

ProcessorTimes processorTimes()
{
  ProcessorTimes times;
  FILETIME idle, kernel, user, created, exited, selfKernel, selfUser;
  // The system's kernel time includes its idle time.
  if (!GetSystemTimes(&idle, &kernel, &user) ||
      !GetProcessTimes(GetCurrentProcess(), &created, &exited, &selfKernel, &selfUser))
    return times;
  times.idle = ticks(idle);
  times.busy = ticks(kernel) + ticks(user) - ticks(idle);
  times.self = ticks(selfKernel) + ticks(selfUser);
  times.valid = true;
  return times;
}

// One engine of one adapter as one process uses it, e.g.
// "pid_1234_luid_0x00000000_0x0000C3F1_phys_0_eng_0_engtype_3D".
struct EngineInstance
{
  bool own = false;
  QString adapter, type;
};

EngineInstance parseEngine(const QString& name, DWORD process)
{
  EngineInstance engine;
  const qsizetype luid = name.indexOf(QStringLiteral("_luid_"));
  const qsizetype phys = name.indexOf(QStringLiteral("_phys_"));
  const qsizetype type = name.lastIndexOf(QStringLiteral("engtype_"));
  if (!name.startsWith(QStringLiteral("pid_")) || luid < 0 || phys < luid || type < 0)
    return engine;
  engine.own = name.mid(4, luid - 4).toULong() == process;
  engine.adapter = name.mid(luid + 6, phys - luid - 6);
  engine.type = name.mid(type + 8);
  return engine;
}
}

SystemLoad::SystemLoad(QObject* parent) : QObject(parent) {}

SystemLoad::~SystemLoad()
{
  stop();
}

void SystemLoad::start()
{
  if (m_thread.joinable())
    return;
  m_stopping = false;
  m_thread = std::thread([this] { run(); });
}

void SystemLoad::stop()
{
  if (!m_thread.joinable())
    return;
  {
    std::lock_guard<std::mutex> lock(m_mutex);
    m_stopping = true;
  }
  m_wake.notify_all();
  m_thread.join();
}

void SystemLoad::run()
{
  const DWORD process = GetCurrentProcessId();

  // Utilization of every graphics engine, per process. The wildcard takes in
  // the engines that appear later (a decoder starting, a CUDA context).
  PDH_HQUERY query = nullptr;
  PDH_HCOUNTER engines = nullptr;
  if (PdhOpenQueryW(nullptr, 0, &query) != ERROR_SUCCESS ||
      PdhAddEnglishCounterW(query, L"\\GPU Engine(*)\\Utilization Percentage", 0, &engines) != ERROR_SUCCESS)
  {
    if (query)
      PdhCloseQuery(query);
    query = nullptr;
  }
  // A rate needs two collections; the first figures come a second from now.
  if (query)
    PdhCollectQueryData(query);
  ProcessorTimes before = processorTimes();

  std::vector<BYTE> buffer;
  // The last graphics figures and how many seconds old they are: a second
  // in which engines appear (a filter starting its CUDA context) has no rate
  // for them yet and the whole read fails.
  double busiest = 0, self = 0, rendering = 0, computing = 0;
  int age = -1;
  for (;;)
  {
    {
      std::unique_lock<std::mutex> lock(m_mutex);
      if (m_wake.wait_for(lock, std::chrono::seconds(1), [this] { return m_stopping; }))
        break;
    }

    QVariantMap load;
    const ProcessorTimes now = processorTimes();
    if (before.valid && now.valid)
    {
      const double idle = double(now.idle - before.idle), busy = double(now.busy - before.busy);
      if (idle + busy > 0)
      {
        load.insert(QStringLiteral("cpu"), std::clamp(100.0 * busy / (idle + busy), 0.0, 100.0));
        // Of all processors together, as the whole-machine figure is.
        load.insert(QStringLiteral("cpuSelf"),
                    std::clamp(100.0 * double(now.self - before.self) / (idle + busy), 0.0, 100.0));
      }
    }
    before = now;

    if (query && PdhCollectQueryData(query) == ERROR_SUCCESS)
    {
      DWORD bytes = 0, count = 0;
      if (PdhGetFormattedCounterArrayW(engines, PDH_FMT_DOUBLE, &bytes, &count, nullptr) == PDH_MORE_DATA)
      {
        buffer.resize(bytes);
        auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(buffer.data());
        if (PdhGetFormattedCounterArrayW(engines, PDH_FMT_DOUBLE, &bytes, &count, items) == ERROR_SUCCESS)
        {
          // Each kind of engine is summed over the processes using it.
          // Rendering (3D) and computing (CUDA, compute: an inference
          // filter) take turns on the same cores, so an adapter is as busy
          // as the two together; the other kinds (video decoding, copying)
          // have hardware of their own and count by the busiest of them.
          struct Adapter { double render = 0, compute = 0, ownShared = 0; QHash<QString, double> other, ownOther; };
          QHash<QString, Adapter> adapters;
          for (DWORD i = 0; i < count; ++i)
          {
            if (items[i].FmtValue.CStatus != PDH_CSTATUS_VALID_DATA && items[i].FmtValue.CStatus != PDH_CSTATUS_NEW_DATA)
              continue;
            const EngineInstance engine = parseEngine(QString::fromWCharArray(items[i].szName), process);
            if (engine.type.isEmpty())
              continue;
            const double value = items[i].FmtValue.doubleValue;
            Adapter& adapter = adapters[engine.adapter];
            const bool render = engine.type == QLatin1String("3D");
            const bool compute = engine.type == QLatin1String("Cuda") || engine.type.startsWith(QLatin1String("Compute"));
            if (render || compute)
            {
              (render ? adapter.render : adapter.compute) += value;
              if (engine.own)
                adapter.ownShared += value;
            }
            else
            {
              adapter.other[engine.type] += value;
              if (engine.own)
                adapter.ownOther[engine.type] += value;
            }
          }
          busiest = self = rendering = computing = 0;
          for (const Adapter& adapter : std::as_const(adapters))
          {
            double total = std::min(100.0, adapter.render + adapter.compute), own = adapter.ownShared;
            for (const double value : adapter.other)
              total = std::max(total, value);
            for (const double value : adapter.ownOther)
              own = std::max(own, value);
            if (total >= busiest)
            {
              busiest = total;
              self = own;
              rendering = adapter.render;
              computing = adapter.compute;
            }
          }
          age = 0;
        }
      }
    }
    if (age >= 0 && age <= 3)
    {
      load.insert(QStringLiteral("gpu"), std::clamp(busiest, 0.0, 100.0));
      load.insert(QStringLiteral("gpuSelf"), std::clamp(self, 0.0, 100.0));
      load.insert(QStringLiteral("gpuRender"), std::clamp(rendering, 0.0, 100.0));
      load.insert(QStringLiteral("gpuCompute"), std::clamp(computing, 0.0, 100.0));
    }
    if (age >= 0)
      ++age;

    QMetaObject::invokeMethod(this, [this, load] { Q_EMIT sampled(load); }, Qt::QueuedConnection);
  }

  if (query)
    PdhCloseQuery(query);
}
