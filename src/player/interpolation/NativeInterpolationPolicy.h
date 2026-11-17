#pragma once
// Apple-native frame interpolation on the Mac (设置 → 视频 → 系统原生补帧):
// which mpv filter a setting gives, what hardware decoding it needs, and what
// to tell the viewer when the filter keeps a video's own frames. The filter is
// apple/NativeInterpolation/vf_tigerest_vtfi.c, built into the bundled libmpv.
#include <QString>
#include <QVariantMap>

namespace native {
enum class Mode { Off, Quality, Efficient };

constexpr const char* FilterLabel = "tigerest-vtfi";

Mode modeFromSetting(const QString& setting);
QString modeName(Mode mode);
// "@tigerest-vtfi:tigerest-vtfi=mode=…:factor=2" or "…:target=60"; empty
// for Off. target is the setting ("2x", "60", "display"); displayFps the
// refresh rate of the window's screen (0 when unknown).
QString filterText(Mode mode, const QString& target, double displayFps);
// The filter takes VideoToolbox hardware frames. Copy-back modes hand it
// software frames, so while it runs they become the zero-copy "auto" (still
// VideoToolbox on a Mac). Returns the replacement, or empty to keep current;
// deliberate software decoding ("no") is kept.
QString hardwareDecoding(const QString& current);
// What to show once per item for a status the filter reports; empty when
// there is nothing to tell.
QString notice(const QString& status);
// The filter's statistics (vf-metadata) as the page's interpolation panel
// reads them: status, mode, rates, counters, timings.
QVariantMap diagnostics(const QVariantMap& metadata, const QString& filter);
}
