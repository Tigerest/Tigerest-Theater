#pragma once

#include <QObject>
#include <QVariantMap>

#include <condition_variable>
#include <mutex>
#include <thread>

// Processor and graphics load for professional mode's gauges on the Mac, the
// same figures as the Windows sampler (src/utils/win/SystemLoad.h), once a
// second on a thread of its own while the mode is on. Percentages, 0-100:
// "cpu" and "gpu" are the whole machine's, "cpuSelf" and "gpuSelf" this
// process's share of them (mpv renders in this process). The graphics figure
// is the GPU's device utilisation from its IOAccelerator statistics; macOS
// does not split it into rendering and computing, so those are left out.
class SystemLoad : public QObject
{
  Q_OBJECT
public:
  explicit SystemLoad(QObject* parent = nullptr);
  ~SystemLoad() override;

  void start();
  void stop();

Q_SIGNALS:
  void sampled(const QVariantMap& load);

private:
  void run();

  std::thread m_thread;
  std::mutex m_mutex;
  std::condition_variable m_wake;
  bool m_stopping = false;
};
