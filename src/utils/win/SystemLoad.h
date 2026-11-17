#pragma once

#include <QObject>
#include <QVariantMap>

#include <atomic>
#include <condition_variable>
#include <mutex>
#include <thread>

// Processor and graphics-card load for professional mode's gauges. Sampled
// once a second on a thread of its own while the mode is on: reading the
// graphics counters takes several milliseconds.
//
// Every figure is a percentage, 0-100: "cpu" and "gpu" are the whole
// machine's, "cpuSelf" and "gpuSelf" this process's share of them. The
// graphics figure is the busiest adapter's: its rendering ("gpuRender") and
// computing ("gpuCompute") together, since an inference filter and the
// renderer take turns on the same cores, or a busier engine of another kind.
// A figure Windows cannot give is left out.
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
