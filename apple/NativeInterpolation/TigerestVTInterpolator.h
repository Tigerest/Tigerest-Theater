// Apple-native frame interpolation with VideoToolbox's frame processors.
// Shared by the mpv filter in vf_tigerest_vtfi.c on macOS (built into the
// desktop libmpv), iOS and tvOS (linked into the apps). Plain C interface so
// the filter stays C; the implementation is Objective-C and builds with or
// without ARC.
#pragma once
#include <CoreVideo/CoreVideo.h>
#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

// VTFrameRateConversionConfiguration: best quality, any phase, several frames
// per pair. Not on tvOS.
#define TGVT_MODE_QUALITY 1
// VTLowLatencyFrameInterpolationConfiguration: lighter, 2x or 4x, NV12 only,
// at most 1920x1080. The only one on tvOS.
#define TGVT_MODE_EFFICIENT 2

typedef struct tgvt_engine tgvt_engine;

// Whether this device and system offer the mode at all.
bool tgvt_mode_supported(int mode);
// Whether the mode accepts frames of this size. Measured on an M4 Pro, the
// quality mode needs 22 ms per 1080p pair and 58 ms at 1440p, more than a
// 24 fps frame lasts; the efficient mode fails above 1920x1080.
bool tgvt_size_supported(int mode, int width, int height);

// Creates a session for frames of exactly width x height. Loading the
// system's model can take seconds the first time a size is used, so call it
// off the playback thread. points (efficient mode): uniformly spaced points
// per pair, 1 gives 0.5, 2 gives 0.25, 0.5 and 0.75. Returns NULL and fills
// error on failure.
tgvt_engine *tgvt_create(int mode, int width, int height, int points, char *error, size_t error_size);
void tgvt_destroy(tgvt_engine *engine);
int tgvt_mode(const tgvt_engine *engine);

// Interpolates between prev (earlier, at prev_pts seconds) and next. The
// engine keeps its converted copy of next, so the following pair can reuse it
// when it starts at next_pts; anything else starts a new sequence. out
// receives count new buffers (+1 retained) in next's pixel format, size and
// attachments. Efficient mode accepts only its uniform points. ms receives the
// time spent, conversions included.
bool tgvt_interpolate(tgvt_engine *engine, CVPixelBufferRef prev, double prev_pts,
                      CVPixelBufferRef next, double next_pts, const float *phases, int count,
                      CVPixelBufferRef *out, double *ms, char *error, size_t error_size);

// Compares the luma of two frames on a sparse grid (no copy of the frames).
// mean: mean absolute difference, 0..1 of the coded range; changed: share of
// samples that moved by more than noise; histogram: L1 distance of 32-bin
// luma histograms, 0..2. Returns false if a frame cannot be read.
bool tgvt_compare(CVPixelBufferRef a, CVPixelBufferRef b, double *mean, double *changed, double *histogram);

#ifdef __cplusplus
}
#endif
