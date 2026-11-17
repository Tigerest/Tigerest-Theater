#include "SystemLoad.h"

#import <Foundation/Foundation.h>
#include <IOKit/IOKitLib.h>
#include <mach/mach.h>
#include <mach/mach_host.h>
#include <mach/mach_time.h>
#include <sys/resource.h>

#include <algorithm>
#include <chrono>

namespace
{
struct ProcessorTicks
{
  quint64 busy = 0, total = 0;
  bool valid = false;
};

ProcessorTicks processorTicks()
{
  ProcessorTicks ticks;
  natural_t count = 0;
  processor_info_array_t info = nullptr;
  mach_msg_type_number_t size = 0;
  if (host_processor_info(mach_host_self(), PROCESSOR_CPU_LOAD_INFO, &count, &info, &size) != KERN_SUCCESS)
    return ticks;
  const auto* load = reinterpret_cast<processor_cpu_load_info_t>(info);
  for (natural_t cpu = 0; cpu < count; ++cpu)
  {
    const auto& t = load[cpu].cpu_ticks;
    ticks.busy += t[CPU_STATE_USER] + t[CPU_STATE_SYSTEM] + t[CPU_STATE_NICE];
    ticks.total += t[CPU_STATE_USER] + t[CPU_STATE_SYSTEM] + t[CPU_STATE_NICE] + t[CPU_STATE_IDLE];
  }
  vm_deallocate(mach_task_self(), reinterpret_cast<vm_address_t>(info), size * sizeof(integer_t));
  ticks.valid = ticks.total > 0;
  return ticks;
}

// Processor time of this process, in seconds.
double processSeconds()
{
  rusage usage{};
  if (getrusage(RUSAGE_SELF, &usage) != 0)
    return -1;
  return usage.ru_utime.tv_sec + usage.ru_stime.tv_sec + (usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1e6;
}

// GPU time this process used, in nanoseconds (-1 when unavailable).
double processGpuNanoseconds()
{
  task_power_info_v2 info{};
  mach_msg_type_number_t count = TASK_POWER_INFO_V2_COUNT;
  if (task_info(mach_task_self(), TASK_POWER_INFO_V2, reinterpret_cast<task_info_t>(&info), &count) != KERN_SUCCESS)
    return -1;
  return double(info.gpu_energy.task_gpu_utilisation);
}

// The busiest GPU's device utilisation, from its IOAccelerator statistics
// (readable without privileges); -1 when there is none.
double deviceUtilisation()
{
  io_iterator_t iterator = IO_OBJECT_NULL;
  if (IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOAccelerator"), &iterator) != KERN_SUCCESS)
    return -1;
  double busiest = -1;
  for (io_object_t service = IOIteratorNext(iterator); service; service = IOIteratorNext(iterator))
  {
    CFTypeRef stats = IORegistryEntryCreateCFProperty(service, CFSTR("PerformanceStatistics"), kCFAllocatorDefault, 0);
    if (stats && CFGetTypeID(stats) == CFDictionaryGetTypeID())
    {
      CFTypeRef value = CFDictionaryGetValue(static_cast<CFDictionaryRef>(stats), CFSTR("Device Utilization %"));
      double percent = 0;
      if (value && CFGetTypeID(value) == CFNumberGetTypeID() &&
          CFNumberGetValue(static_cast<CFNumberRef>(value), kCFNumberDoubleType, &percent))
        busiest = std::max(busiest, percent);
    }
    if (stats)
      CFRelease(stats);
    IOObjectRelease(service);
  }
  IOObjectRelease(iterator);
  return busiest;
}
}

SystemLoad::SystemLoad(QObject* parent) : QObject(parent)
{
}

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
  const int cores = std::max(1, int([NSProcessInfo processInfo].activeProcessorCount));
  ProcessorTicks before = processorTicks();
  double selfBefore = processSeconds(), gpuBefore = processGpuNanoseconds();
  auto then = std::chrono::steady_clock::now();
  while (true)
  {
    {
      std::unique_lock<std::mutex> lock(m_mutex);
      if (m_wake.wait_for(lock, std::chrono::seconds(1), [this] { return m_stopping; }))
        return;
    }
    const auto now = std::chrono::steady_clock::now();
    const double seconds = std::chrono::duration<double>(now - then).count();
    then = now;
    QVariantMap load;
    const ProcessorTicks after = processorTicks();
    if (before.valid && after.valid && after.total > before.total)
      load.insert(QStringLiteral("cpu"), std::clamp(100.0 * (after.busy - before.busy) / (after.total - before.total), 0.0, 100.0));
    before = after;
    const double self = processSeconds();
    if (self >= 0 && selfBefore >= 0 && seconds > 0)
      load.insert(QStringLiteral("cpuSelf"), std::clamp(100.0 * (self - selfBefore) / (seconds * cores), 0.0, 100.0));
    selfBefore = self;
    const double device = deviceUtilisation();
    if (device >= 0)
      load.insert(QStringLiteral("gpu"), std::clamp(device, 0.0, 100.0));
    const double gpu = processGpuNanoseconds();
    if (gpu >= 0 && gpuBefore >= 0 && seconds > 0 && gpu >= gpuBefore)
      load.insert(QStringLiteral("gpuSelf"), std::clamp(100.0 * (gpu - gpuBefore) / (seconds * 1e9), 0.0, 100.0));
    gpuBefore = gpu;
    QMetaObject::invokeMethod(this, [this, load] { Q_EMIT sampled(load); }, Qt::QueuedConnection);
  }
}
