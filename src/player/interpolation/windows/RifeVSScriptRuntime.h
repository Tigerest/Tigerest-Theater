#pragma once
#include <QString>
namespace rife {
// The caller must first verify the extension and finish its private probe.
// Must run BEFORE mpv_create: Windows mpv caches the environment at that point.
// A process keeps one version loaded; extension changes take effect on restart.
bool activateVSScriptRuntime(const QString& verifiedRoot,QString* error=nullptr);
// Read-only check for playback hooks. Never activates a runtime after startup.
bool validateVSScriptRuntime(const QString& verifiedRoot,QString* error=nullptr);
// CUDA device 0's compute capability from the NVIDIA driver ("8.9"), the
// device the RIFE probe and NVIDIA's runtime use; empty without a CUDA
// driver. Asked once, on the first call, which loads the driver.
QString cudaComputeCapability();
}
