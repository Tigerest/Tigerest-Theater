// VapourSynth (API 4) plugin that turns NVIDIA Video Frame Generation into a
// frame-rate converter for real-time playback.
//
//   core.tigerest_vfg.Interpolate(clip, runtime, fpsnum, fpsden, mode=2, autoshot=1,
//                                 srcfpsnum=clip fps, srcfpsden=clip fps, scenecut=0)
//     clip     RGB24 or RGB30, constant format and size
//     runtime  directory holding NVVideoEffects.dll, NVCVImage.dll and the
//              VideoFrameGeneration feature DLL (UTF-8)
//     fpsnum/fpsden        output frame rate, not below the source rate
//     mode     0 low, 1 medium, 2 high
//     autoshot 1 keeps the SDK's automatic shot-change detection on
//     srcfpsnum/srcfpsden  source frame rate when the clip carries none (mpv)
//     scenecut 0 leaves shot changes to the SDK alone. Above 0, a pair whose mean
//              absolute RGB difference (0..1) reaches it is also treated as a
//              shot change, without running the effect (the RIFE script uses 0.25)
//   Output frame n shows source time n * srcfps / outfps. A whole number returns
//   that source frame; anything else is generated between its two neighbours.
//
//   core.tigerest_vfg.Sample(clip, fpsnum, fpsden, hold=0, srcfpsnum, srcfpsden)
//     The same frame mapping without generation, for any constant format: frame
//     n is source frame floor(n * srcfps / outfps). The script uses it to pass
//     original frames through without an RGB round trip. hold=1 divides each
//     source frame's own duration over its repeats (variable frame rate input).
//     The duration the source frame arrived with is kept as
//     _TigerestVfgSourceDurationNum/_TigerestVfgSourceDurationDen.
//
//   core.tigerest_vfg.Substitute(clip, original)
//     clip's frame where it was generated (_TigerestVfgGenerated = 1), otherwise
//     original's frame with the same number. The script uses it to show the
//     input frame itself, not its RGB copy, where Interpolate repeated a frame.
//
// Frame properties written: _DurationNum/_DurationDen, _TigerestVfgGenerated,
// and from Interpolate also _TigerestVfgShotChange, _TigerestVfgTimeMs,
// _TigerestVfgSceneDifference (with scenecut) and
// _TigerestVfgUploads and _TigerestVfgRuns (source frames uploaded and effect
// runs so far by this instance).
#define NOMINMAX
#include "VfgApi.h"
#include "VapourSynth4.h"
#include <emmintrin.h>
#include <algorithm>
#include <climits>
#include <cstdint>
#include <cstring>
#include <memory>
#include <mutex>
#include <numeric>
#include <string>

namespace {

double nowMs() {
    static const double frequency = [] { LARGE_INTEGER f; QueryPerformanceFrequency(&f); return double(f.QuadPart); }();
    LARGE_INTEGER counter; QueryPerformanceCounter(&counter);
    return double(counter.QuadPart) * 1000.0 / frequency;
}

std::wstring widen(const std::string& text) {
    if (text.empty()) return {};
    const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), int(text.size()), nullptr, 0);
    if (size <= 0) throw std::runtime_error("the runtime path is not valid UTF-8");
    std::wstring wide(size_t(size), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, text.data(), int(text.size()), wide.data(), size);
    return wide;
}

// ---------------------------------------------------------------- timing

// Maps output frames to source time and stamps frame durations.
struct Timing {
    int64_t stepNum = 1, stepDen = 1;  // source frames per output frame, reduced, at most 1
    int64_t srcNum = 0, srcDen = 1;    // source frame rate
    int64_t outNum = 0, outDen = 1;    // output frame rate, reduced
    int sourceFrames = 0, outputFrames = 0;

    Timing(const VSVideoInfo& source, int64_t fpsNum, int64_t fpsDen, int64_t sourceNum, int64_t sourceDen) {
        const int64_t limit = INT32_MAX;
        if (sourceNum <= 0 || sourceDen <= 0) { sourceNum = source.fpsNum; sourceDen = source.fpsDen; }
        if (sourceNum <= 0 || sourceDen <= 0)
            throw std::runtime_error("the clip has no frame rate; pass srcfpsnum and srcfpsden");
        if (fpsNum <= 0 || fpsDen <= 0 || fpsNum > limit || fpsDen > limit || sourceNum > limit || sourceDen > limit)
            throw std::runtime_error("frame rates must be positive fractions of 32-bit integers");
        const int64_t outGcd = std::gcd(fpsNum, fpsDen), srcGcd = std::gcd(sourceNum, sourceDen);
        outNum = fpsNum / outGcd; outDen = fpsDen / outGcd;
        srcNum = sourceNum / srcGcd; srcDen = sourceDen / srcGcd;
        const int64_t a = std::gcd(srcNum, outNum), b = std::gcd(outDen, srcDen);
        stepNum = (srcNum / a) * (outDen / b);
        stepDen = (srcDen / b) * (outNum / a);
        if (stepNum > stepDen) throw std::runtime_error("the output frame rate must not be below the source frame rate");
        if (stepDen > (int64_t(1) << 30)) throw std::runtime_error("the frame rate ratio is too fine to schedule");
        sourceFrames = source.numFrames;
        const int64_t frames = (int64_t(sourceFrames) * stepDen + stepNum - 1) / stepNum;
        outputFrames = int(std::min<int64_t>(frames, INT_MAX));
    }

    void locate(int n, int64_t& index, int64_t& phase) const {
        const int64_t position = int64_t(n) * stepNum;
        index = position / stepDen;
        phase = position % stepDen;
    }

    static void write(const VSAPI* api, VSMap* props, int64_t num, int64_t den) {
        const int64_t divisor = std::gcd(num, den);
        if (divisor > 1) { num /= divisor; den /= divisor; }
        while (num > INT32_MAX || den > INT32_MAX) { num >>= 1; den >>= 1; }  // mpv reads both as int
        if (num <= 0 || den <= 0) return;
        api->mapSetInt(props, "_DurationNum", num, maReplace);
        api->mapSetInt(props, "_DurationDen", den, maReplace);
    }

    bool isLast(const VSAPI* api, const VSMap* props, int64_t index) const {
        if (index + 1 >= sourceFrames) return true;
        int error = 0;
        return api->mapGetInt(props, "_TigerestLastFrame", 0, &error) == 1 && !error;  // set by the patched mpv
    }

    // One output frame lasts 1/outfps. The slots of the last source frame stop
    // where that frame ends, so the output keeps the source's total duration.
    void stamp(const VSAPI* api, VSMap* props, int64_t index, int64_t phase) const {
        if (isLast(api, props, index) && phase + stepNum > stepDen) write(api, props, (stepDen - phase) * srcDen, stepDen * srcNum);
        else write(api, props, outDen, outNum);
    }

    // Repeats only: the source frame's own duration, shared by its repeats.
    void stampHeld(const VSAPI* api, VSMap* props, int64_t index) const {
        int errorNum = 0, errorDen = 0;
        int64_t num = api->mapGetInt(props, "_DurationNum", 0, &errorNum), den = api->mapGetInt(props, "_DurationDen", 0, &errorDen);
        if (errorNum || errorDen || num <= 0 || den <= 0) { num = srcDen; den = srcNum; }
        int64_t repeats = ((index + 1) * stepDen + stepNum - 1) / stepNum - (index * stepDen + stepNum - 1) / stepNum;
        const int64_t divisor = std::gcd(num, repeats);
        num /= divisor; repeats /= divisor;
        while (den > INT64_MAX / repeats) { den >>= 1; num >>= 1; }
        write(api, props, num, den * repeats);
    }
};

// ---------------------------------------------------------------- pixels

// VapourSynth RGB is planar, the SDK wants one interleaved 32-bit pixel.
void packRgba8(const uint8_t* r, const uint8_t* g, const uint8_t* b, uint8_t* out, int width) {
    const __m128i alpha = _mm_set1_epi8(-1);
    int x = 0;
    for (; x + 16 <= width; x += 16) {
        const __m128i vr = _mm_loadu_si128(reinterpret_cast<const __m128i*>(r + x));
        const __m128i vg = _mm_loadu_si128(reinterpret_cast<const __m128i*>(g + x));
        const __m128i vb = _mm_loadu_si128(reinterpret_cast<const __m128i*>(b + x));
        const __m128i rgLow = _mm_unpacklo_epi8(vr, vg), rgHigh = _mm_unpackhi_epi8(vr, vg);
        const __m128i baLow = _mm_unpacklo_epi8(vb, alpha), baHigh = _mm_unpackhi_epi8(vb, alpha);
        auto* target = reinterpret_cast<__m128i*>(out + size_t(x) * 4);
        _mm_storeu_si128(target, _mm_unpacklo_epi16(rgLow, baLow));
        _mm_storeu_si128(target + 1, _mm_unpackhi_epi16(rgLow, baLow));
        _mm_storeu_si128(target + 2, _mm_unpacklo_epi16(rgHigh, baHigh));
        _mm_storeu_si128(target + 3, _mm_unpackhi_epi16(rgHigh, baHigh));
    }
    for (; x < width; ++x) { out[x * 4] = r[x]; out[x * 4 + 1] = g[x]; out[x * 4 + 2] = b[x]; out[x * 4 + 3] = 255; }
}

void unpackRgba8(const uint8_t* in, uint8_t* r, uint8_t* g, uint8_t* b, int width) {
    const __m128i mask = _mm_set1_epi32(0xFF);
    int x = 0;
    for (; x + 16 <= width; x += 16) {
        const auto* source = reinterpret_cast<const __m128i*>(in + size_t(x) * 4);
        const __m128i p0 = _mm_loadu_si128(source), p1 = _mm_loadu_si128(source + 1);
        const __m128i p2 = _mm_loadu_si128(source + 2), p3 = _mm_loadu_si128(source + 3);
        auto channel = [&](int shift) {
            const __m128i low = _mm_packs_epi32(_mm_and_si128(_mm_srli_epi32(p0, shift), mask), _mm_and_si128(_mm_srli_epi32(p1, shift), mask));
            const __m128i high = _mm_packs_epi32(_mm_and_si128(_mm_srli_epi32(p2, shift), mask), _mm_and_si128(_mm_srli_epi32(p3, shift), mask));
            return _mm_packus_epi16(low, high);
        };
        _mm_storeu_si128(reinterpret_cast<__m128i*>(r + x), channel(0));
        _mm_storeu_si128(reinterpret_cast<__m128i*>(g + x), channel(8));
        _mm_storeu_si128(reinterpret_cast<__m128i*>(b + x), channel(16));
    }
    for (; x < width; ++x) { r[x] = in[x * 4]; g[x] = in[x * 4 + 1]; b[x] = in[x * 4 + 2]; }
}

// Ten bits per channel in one word, red in the low bits (found by vfg_proto probe).
void packRgb10(const uint16_t* r, const uint16_t* g, const uint16_t* b, uint32_t* out, int width) {
    const __m128i zero = _mm_setzero_si128(), limit = _mm_set1_epi16(1023), alpha = _mm_set1_epi32(int(0xC0000000u));
    auto clamp = [&](const uint16_t* plane) {
        const __m128i value = _mm_loadu_si128(reinterpret_cast<const __m128i*>(plane));
        return _mm_sub_epi16(value, _mm_subs_epu16(value, limit));  // unsigned minimum
    };
    int x = 0;
    for (; x + 8 <= width; x += 8) {
        const __m128i vr = clamp(r + x), vg = clamp(g + x), vb = clamp(b + x);
        const __m128i low = _mm_or_si128(_mm_or_si128(_mm_unpacklo_epi16(vr, zero), _mm_slli_epi32(_mm_unpacklo_epi16(vg, zero), 10)),
                                         _mm_or_si128(_mm_slli_epi32(_mm_unpacklo_epi16(vb, zero), 20), alpha));
        const __m128i high = _mm_or_si128(_mm_or_si128(_mm_unpackhi_epi16(vr, zero), _mm_slli_epi32(_mm_unpackhi_epi16(vg, zero), 10)),
                                          _mm_or_si128(_mm_slli_epi32(_mm_unpackhi_epi16(vb, zero), 20), alpha));
        _mm_storeu_si128(reinterpret_cast<__m128i*>(out + x), low);
        _mm_storeu_si128(reinterpret_cast<__m128i*>(out + x + 4), high);
    }
    for (; x < width; ++x)
        out[x] = uint32_t(std::min<uint16_t>(r[x], 1023)) | uint32_t(std::min<uint16_t>(g[x], 1023)) << 10
               | uint32_t(std::min<uint16_t>(b[x], 1023)) << 20 | 0xC0000000u;
}

void unpackRgb10(const uint32_t* in, uint16_t* r, uint16_t* g, uint16_t* b, int width) {
    const __m128i mask = _mm_set1_epi32(0x3FF);
    int x = 0;
    for (; x + 8 <= width; x += 8) {
        const __m128i p0 = _mm_loadu_si128(reinterpret_cast<const __m128i*>(in + x));
        const __m128i p1 = _mm_loadu_si128(reinterpret_cast<const __m128i*>(in + x + 4));
        auto channel = [&](int shift) {
            return _mm_packs_epi32(_mm_and_si128(_mm_srli_epi32(p0, shift), mask), _mm_and_si128(_mm_srli_epi32(p1, shift), mask));
        };
        _mm_storeu_si128(reinterpret_cast<__m128i*>(r + x), channel(0));
        _mm_storeu_si128(reinterpret_cast<__m128i*>(g + x), channel(10));
        _mm_storeu_si128(reinterpret_cast<__m128i*>(b + x), channel(20));
    }
    for (; x < width; ++x) { r[x] = uint16_t(in[x] & 0x3FF); g[x] = uint16_t(in[x] >> 10 & 0x3FF); b[x] = uint16_t(in[x] >> 20 & 0x3FF); }
}

// ---------------------------------------------------------------- session

// One effect instance and one CUDA stream. Uploaded source frames stay on the
// GPU, keyed by source frame number, so frames generated between the same pair
// (and the frame shared by two consecutive pairs) are uploaded once.
class Session {
public:
    struct Result { bool generated = false, shotChange = false; double ms = 0, difference = -1; int64_t uploads = 0, runs = 0; };

    Session(const std::wstring& directory, unsigned width, unsigned height, int mode, bool deep, bool autoShot, double sceneCut)
        : w(width), h(height), tenBit(deep), detectShots(autoShot), cut(sceneCut) {
        for (const wchar_t* name : {L"NVVideoEffects.dll", L"NVCVImage.dll"})
            if (GetFileAttributesW((directory + L"\\" + name).c_str()) == INVALID_FILE_ATTRIBUTES)
                throw std::runtime_error("the VFG runtime directory does not contain NVVideoEffects.dll and NVCVImage.dll");
        try {
            api.load(directory);
            const int format = tenBit ? kPackedRgb10 : vfg::FormatRGBA, type = tenBit ? vfg::TypeP32 : vfg::TypeU8;
            api.check(api.CudaStreamCreate(&stream), "NvVFX_CudaStreamCreate");
            api.check(api.CreateEffect(vfg::kEffect, &effect), "NvVFX_CreateEffect(VideoFrameGeneration)");
            api.check(api.SetCudaStream(effect, vfg::kCudaStream, stream), "set CudaStream");
            api.check(api.SetU32(effect, vfg::kInputWidth, w), "set InputWidth");
            api.check(api.SetU32(effect, vfg::kInputHeight, h), "set InputHeight");
            api.check(api.SetU32(effect, vfg::kMode, unsigned(mode)), "set Mode");
            api.check(api.SetU32(effect, vfg::kAutoShotChange, detectShots ? 1u : 0u), "set AutomaticShotChangeDetectionEnabled");
            api.check(api.Load(effect), "NvVFX_Load (is this an RTX GPU with a current driver?)");
            for (Slot& slot : slots) {
                api.check(api.ImageAlloc(&slot.gpu, w, h, format, type, vfg::LayoutChunky, vfg::MemGpu, 32), "allocate GPU image");
                api.check(api.ImageAlloc(&slot.staging, w, h, format, type, vfg::LayoutChunky, vfg::MemCpuPinned, 32), "allocate pinned image");
            }
            api.check(api.ImageAlloc(&gpuOut, w, h, format, type, vfg::LayoutChunky, vfg::MemGpu, 32), "allocate GPU image");
            api.check(api.ImageAlloc(&stageOut, w, h, format, type, vfg::LayoutChunky, vfg::MemCpuPinned, 32), "allocate pinned image");
            api.check(api.SetImage(effect, vfg::kOutput, &gpuOut), "set DstImage0");
            api.check(api.SetU32(effect, vfg::kFrameMultiplier, 0), "select timestep mode");
        } catch (...) {
            release();
            throw;
        }
    }
    ~Session() { release(); }
    Session(const Session&) = delete;
    Session& operator=(const Session&) = delete;

    // Generates the frame at `timestep` between source frames index and index + 1
    // into `output`. With automatic detection on, the SDK answers a shot change
    // with a bit-exact copy of the nearer source frame instead of a generated
    // one (the API has no flag to read). `output` is then left untouched and the
    // caller repeats the first frame, as playback without interpolation would.
    Result generate(int64_t index, const VSFrame* first, const VSFrame* second, float timestep, VSFrame* output, const VSAPI* vs) {
        std::lock_guard<std::mutex> guard(lock);
        const double started = nowMs();
        Result result;
        try {
            const int a = acquire(index, first, -1, vs);
            const int b = acquire(index + 1, second, a, vs);
            if (cut > 0) {
                if (measured != index) { distance = difference(slots[a].staging, slots[b].staging); measured = index; }
                result.difference = distance;
            }
            if (cut > 0 && distance >= cut) {
                result.shotChange = true;  // too different to belong to one shot: the effect is not run
            } else {
                if (pair != index || pairSlots[0] != a || pairSlots[1] != b) {
                    pair = -1;
                    // The SDK needs both inputs set again for every new pair. ShotChange
                    // is left alone: only the automatic detection decides.
                    api.check(api.SetImage(effect, vfg::kPrevious, &slots[a].gpu), "set SrcImage0");
                    api.check(api.SetImage(effect, vfg::kCurrent, &slots[b].gpu), "set SrcImage1");
                    pair = index; pairSlots[0] = a; pairSlots[1] = b;
                }
                api.check(api.SetF32(effect, vfg::kTimestep, std::clamp(timestep, 0.001f, 0.999f)), "set Timestep");
                api.check(api.Run(effect, 0), "NvVFX_Run");
                ++runs;
                api.check(api.ImageTransfer(&gpuOut, &stageOut, 1.f, stream, &scratch), "download");
                if (api.CudaStreamSynchronize) api.check(api.CudaStreamSynchronize(stream), "synchronize");
                result.shotChange = detectShots && (same(stageOut, slots[a].staging) || same(stageOut, slots[b].staging));
                result.generated = !result.shotChange;
                if (result.generated) unpack(stageOut, output, vs);
            }
        } catch (...) {
            pair = -1;
            throw;
        }
        result.uploads = uploads;
        result.runs = runs;
        result.ms = nowMs() - started;
        return result;
    }

private:
    static constexpr int kPackedRgb10 = 13;  // the 10-bit packed pixel format reported by "vfg_proto probe"
    static constexpr int kSlots = 3;         // the current pair and the frame before it
    struct Slot { vfg::Image gpu, staging; int64_t key = -1; uint64_t used = 0; };

    int acquire(int64_t key, const VSFrame* frame, int keep, const VSAPI* vs) {
        for (int i = 0; i < kSlots; ++i)
            if (slots[i].key == key) { slots[i].used = ++clock; return i; }
        int target = -1;
        for (int i = 0; i < kSlots; ++i)
            if (i != keep && (target < 0 || slots[i].used < slots[target].used)) target = i;
        Slot& slot = slots[target];
        slot.key = -1;
        if (pairSlots[0] == target || pairSlots[1] == target) pair = -1;
        pack(frame, slot.staging, vs);
        // Asynchronous from pinned memory; the staging copy is kept until the slot is reused.
        api.check(api.ImageTransfer(&slot.staging, &slot.gpu, 1.f, stream, &scratch), "upload");
        slot.key = key;
        slot.used = ++clock;
        ++uploads;
        return target;
    }

    void pack(const VSFrame* frame, vfg::Image& image, const VSAPI* vs) const {
        const uint8_t* planes[3]; ptrdiff_t strides[3];
        for (int p = 0; p < 3; ++p) { planes[p] = vs->getReadPtr(frame, p); strides[p] = vs->getStride(frame, p); }
        auto* target = static_cast<uint8_t*>(image.pixels);
        for (unsigned y = 0; y < h; ++y, target += image.pitch) {
            const uint8_t* r = planes[0] + strides[0] * y; const uint8_t* g = planes[1] + strides[1] * y; const uint8_t* b = planes[2] + strides[2] * y;
            if (tenBit) packRgb10(reinterpret_cast<const uint16_t*>(r), reinterpret_cast<const uint16_t*>(g),
                                  reinterpret_cast<const uint16_t*>(b), reinterpret_cast<uint32_t*>(target), int(w));
            else packRgba8(r, g, b, target, int(w));
        }
    }

    void unpack(const vfg::Image& image, VSFrame* frame, const VSAPI* vs) const {
        uint8_t* planes[3]; ptrdiff_t strides[3];
        for (int p = 0; p < 3; ++p) { planes[p] = vs->getWritePtr(frame, p); strides[p] = vs->getStride(frame, p); }
        const auto* source = static_cast<const uint8_t*>(image.pixels);
        for (unsigned y = 0; y < h; ++y, source += image.pitch) {
            uint8_t* r = planes[0] + strides[0] * y; uint8_t* g = planes[1] + strides[1] * y; uint8_t* b = planes[2] + strides[2] * y;
            if (tenBit) unpackRgb10(reinterpret_cast<const uint32_t*>(source), reinterpret_cast<uint16_t*>(r),
                                    reinterpret_cast<uint16_t*>(g), reinterpret_cast<uint16_t*>(b), int(w));
            else unpackRgba8(source, r, g, b, int(w));
        }
    }

    // Mean absolute difference over R, G and B, 0..1, from every fourth row and pixel.
    double difference(const vfg::Image& left, const vfg::Image& right) const {
        const unsigned bits = tenBit ? 10 : 8, mask = (1u << bits) - 1;
        uint64_t sum = 0, count = 0;
        for (unsigned y = 0; y < h; y += 4) {
            const auto* p = reinterpret_cast<const uint32_t*>(static_cast<const uint8_t*>(left.pixels) + size_t(left.pitch) * y);
            const auto* q = reinterpret_cast<const uint32_t*>(static_cast<const uint8_t*>(right.pixels) + size_t(right.pitch) * y);
            for (unsigned x = 0; x < w; x += 4, ++count)
                for (unsigned shift = 0; shift < 3 * bits; shift += bits) {
                    const int u = int(p[x] >> shift & mask), v = int(q[x] >> shift & mask);
                    sum += uint64_t(u > v ? u - v : v - u);
                }
        }
        return count ? double(sum) / (double(count) * 3.0 * double(mask)) : 0.0;
    }

    bool same(const vfg::Image& left, const vfg::Image& right) const {
        const auto* a = static_cast<const uint8_t*>(left.pixels); const auto* b = static_cast<const uint8_t*>(right.pixels);
        for (unsigned y = 0; y < h; ++y, a += left.pitch, b += right.pitch)
            if (std::memcmp(a, b, size_t(w) * 4) != 0) return false;
        return true;
    }

    void release() {
        if (effect) api.DestroyEffect(effect);
        effect = nullptr;
        if (api.ImageDealloc) {
            for (Slot& slot : slots) { api.ImageDealloc(&slot.gpu); api.ImageDealloc(&slot.staging); }
            for (auto* image : {&gpuOut, &stageOut, &scratch}) api.ImageDealloc(image);
        }
        if (stream) api.CudaStreamDestroy(stream);
        stream = nullptr;
        api.releaseDirectory();
    }

    vfg::Api api;
    std::mutex lock;
    unsigned w, h;
    bool tenBit, detectShots;
    double cut, distance = 0;
    int64_t measured = -1;
    vfg::CudaStream stream = nullptr;
    vfg::Effect effect = nullptr;
    Slot slots[kSlots];
    vfg::Image gpuOut, stageOut, scratch;
    int64_t pair = -1, uploads = 0, runs = 0;
    int pairSlots[2] = {-1, -1};
    uint64_t clock = 0;
};

// ---------------------------------------------------------------- filters

int64_t integer(const VSAPI* api, const VSMap* map, const char* name, int64_t fallback) {
    int error = 0;
    const int64_t value = api->mapGetInt(map, name, 0, &error);
    return error ? fallback : value;
}

struct Interpolator {
    VSNode* node = nullptr;
    VSVideoInfo info{};
    std::unique_ptr<Timing> timing;
    std::unique_ptr<Session> session;
};

const VSFrame* VS_CC interpolateFrame(int n, int activation, void* instance, void**, VSFrameContext* context, VSCore* core, const VSAPI* api) {
    auto* self = static_cast<Interpolator*>(instance);
    int64_t index = 0, phase = 0;
    self->timing->locate(n, index, phase);
    // Past the last source frame of a clip with a known end there is nothing to
    // generate towards: the last frame is repeated.
    const bool between = phase != 0 && index + 1 < self->timing->sourceFrames;
    if (activation == arInitial) {
        api->requestFrameFilter(int(index), self->node, context);
        if (between) api->requestFrameFilter(int(index + 1), self->node, context);
        return nullptr;
    }
    if (activation != arAllFramesReady) return nullptr;
    const VSFrame* first = api->getFrameFilter(int(index), self->node, context);
    const VSFrame* second = between ? api->getFrameFilter(int(index + 1), self->node, context) : nullptr;
    VSFrame* output = nullptr;
    try {
        if (!first || (between && !second)) throw std::runtime_error("a source frame is missing");
        Session::Result result;
        if (between) {
            output = api->newVideoFrame(&self->info.format, self->info.width, self->info.height, first, core);
            if (!output) throw std::runtime_error("cannot allocate the output frame");
            result = self->session->generate(index, first, second, float(double(phase) / double(self->timing->stepDen)), output, api);
            if (!result.generated) { api->freeFrame(output); output = nullptr; }
        }
        // A source frame goes out as it is: the pixels are shared, only the properties are new.
        if (!output) output = api->copyFrame(first, core);
        if (!output) throw std::runtime_error("cannot allocate the output frame");
        VSMap* props = api->getFramePropertiesRW(output);
        self->timing->stamp(api, props, index, phase);
        api->mapSetInt(props, "_TigerestVfgGenerated", result.generated ? 1 : 0, maReplace);
        api->mapSetInt(props, "_TigerestVfgShotChange", result.shotChange ? 1 : 0, maReplace);
        if (between) {
            api->mapSetFloat(props, "_TigerestVfgTimeMs", result.ms, maReplace);
            api->mapSetInt(props, "_TigerestVfgUploads", result.uploads, maReplace);
            api->mapSetInt(props, "_TigerestVfgRuns", result.runs, maReplace);
            if (result.difference >= 0) api->mapSetFloat(props, "_TigerestVfgSceneDifference", result.difference, maReplace);
        }
    } catch (const std::exception& error) {
        if (output) api->freeFrame(output);
        output = nullptr;
        api->setFilterError((std::string("tigerest_vfg.Interpolate: ") + error.what()).c_str(), context);
    } catch (...) {
        if (output) api->freeFrame(output);
        output = nullptr;
        api->setFilterError("tigerest_vfg.Interpolate: unexpected failure", context);
    }
    if (first) api->freeFrame(first);
    if (second) api->freeFrame(second);
    return output;
}

void VS_CC interpolateFree(void* instance, VSCore*, const VSAPI* api) {
    auto* self = static_cast<Interpolator*>(instance);
    self->session.reset();
    api->freeNode(self->node);
    delete self;
}

void VS_CC interpolateCreate(const VSMap* in, VSMap* out, void*, VSCore* core, const VSAPI* api) {
    auto self = std::make_unique<Interpolator>();
    try {
        self->node = api->mapGetNode(in, "clip", 0, nullptr);
        if (!self->node) throw std::runtime_error("a clip is required");
        const VSVideoInfo* source = api->getVideoInfo(self->node);
        const VSVideoFormat& format = source->format;
        const bool rgb = format.colorFamily == cfRGB && format.sampleType == stInteger;
        if (!rgb || (format.bitsPerSample != 8 && format.bitsPerSample != 10))
            throw std::runtime_error("the clip must be RGB24 or RGB30 with a constant format");
        if (source->width <= 0 || source->height <= 0) throw std::runtime_error("the clip must have a constant size");
        const int64_t mode = integer(api, in, "mode", 2);
        if (mode < 0 || mode > 2) throw std::runtime_error("mode must be 0 (low), 1 (medium) or 2 (high)");
        self->timing = std::make_unique<Timing>(*source, integer(api, in, "fpsnum", 0), integer(api, in, "fpsden", 0),
                                                integer(api, in, "srcfpsnum", 0), integer(api, in, "srcfpsden", 0));
        int error = 0;
        const char* runtime = api->mapGetData(in, "runtime", 0, &error);
        if (error || !runtime || !*runtime) throw std::runtime_error("runtime must name the VFG runtime directory");
        std::wstring directory = widen(runtime);
        while (!directory.empty() && (directory.back() == L'\\' || directory.back() == L'/')) directory.pop_back();
        int missing = 0;
        const double sceneCut = api->mapGetFloat(in, "scenecut", 0, &missing);
        if (!missing && !(sceneCut >= 0 && sceneCut <= 1)) throw std::runtime_error("scenecut must be between 0 and 1");
        self->session = std::make_unique<Session>(directory, unsigned(source->width), unsigned(source->height), int(mode),
                                                  format.bitsPerSample == 10, integer(api, in, "autoshot", 1) != 0,
                                                  missing ? 0.0 : sceneCut);
        self->info = *source;
        self->info.fpsNum = self->timing->outNum;
        self->info.fpsDen = self->timing->outDen;
        self->info.numFrames = self->timing->outputFrames;
        VSFilterDependency dependency{self->node, rpGeneral};
        // Source frames are requested in parallel; the effect itself runs one frame at a time.
        api->createVideoFilter(out, "TigerestVfgInterpolate", &self->info, interpolateFrame, interpolateFree,
                               fmParallelRequests, &dependency, 1, self.get(), core);
        // A rejected filter never calls interpolateFree.
        if (api->mapGetError(out)) { self->session.reset(); api->freeNode(self->node); return; }
        self.release();
    } catch (const std::exception& error) {
        self->session.reset();
        if (self->node) api->freeNode(self->node);
        api->mapSetError(out, (std::string("tigerest_vfg.Interpolate: ") + error.what()).c_str());
    } catch (...) {
        self->session.reset();
        if (self->node) api->freeNode(self->node);
        api->mapSetError(out, "tigerest_vfg.Interpolate: unexpected failure");
    }
}

struct Sampler {
    VSNode* node = nullptr;
    VSVideoInfo info{};
    std::unique_ptr<Timing> timing;
    bool hold = false;
};

const VSFrame* VS_CC sampleFrame(int n, int activation, void* instance, void**, VSFrameContext* context, VSCore* core, const VSAPI* api) {
    auto* self = static_cast<Sampler*>(instance);
    int64_t index = 0, phase = 0;
    self->timing->locate(n, index, phase);
    if (activation == arInitial) { api->requestFrameFilter(int(index), self->node, context); return nullptr; }
    if (activation != arAllFramesReady) return nullptr;
    const VSFrame* source = api->getFrameFilter(int(index), self->node, context);
    if (!source) return nullptr;
    VSFrame* output = api->copyFrame(source, core);
    api->freeFrame(source);
    if (!output) { api->setFilterError("tigerest_vfg.Sample: cannot allocate the output frame", context); return nullptr; }
    VSMap* props = api->getFramePropertiesRW(output);
    // The duration is about to become the output cadence. Whoever judges the
    // source's timing from this frame needs the value it arrived with.
    int errorNum = 0, errorDen = 0;
    const int64_t sourceNum = api->mapGetInt(props, "_DurationNum", 0, &errorNum);
    const int64_t sourceDen = api->mapGetInt(props, "_DurationDen", 0, &errorDen);
    if (!errorNum && !errorDen) {
        api->mapSetInt(props, "_TigerestVfgSourceDurationNum", sourceNum, maReplace);
        api->mapSetInt(props, "_TigerestVfgSourceDurationDen", sourceDen, maReplace);
    }
    if (self->hold) self->timing->stampHeld(api, props, index);
    else self->timing->stamp(api, props, index, phase);
    api->mapSetInt(props, "_TigerestVfgGenerated", 0, maReplace);
    return output;
}

void VS_CC sampleFree(void* instance, VSCore*, const VSAPI* api) {
    auto* self = static_cast<Sampler*>(instance);
    api->freeNode(self->node);
    delete self;
}

void VS_CC sampleCreate(const VSMap* in, VSMap* out, void*, VSCore* core, const VSAPI* api) {
    auto self = std::make_unique<Sampler>();
    try {
        self->node = api->mapGetNode(in, "clip", 0, nullptr);
        if (!self->node) throw std::runtime_error("a clip is required");
        const VSVideoInfo* source = api->getVideoInfo(self->node);
        if (source->format.colorFamily == cfUndefined || source->width <= 0 || source->height <= 0)
            throw std::runtime_error("the clip must have a constant format and size");
        self->timing = std::make_unique<Timing>(*source, integer(api, in, "fpsnum", 0), integer(api, in, "fpsden", 0),
                                                integer(api, in, "srcfpsnum", 0), integer(api, in, "srcfpsden", 0));
        self->hold = integer(api, in, "hold", 0) != 0;
        self->info = *source;
        self->info.fpsNum = self->timing->outNum;
        self->info.fpsDen = self->timing->outDen;
        self->info.numFrames = self->timing->outputFrames;
        VSFilterDependency dependency{self->node, rpGeneral};
        api->createVideoFilter(out, "TigerestVfgSample", &self->info, sampleFrame, sampleFree, fmParallel, &dependency, 1, self.get(), core);
        if (api->mapGetError(out)) { api->freeNode(self->node); return; }
        self.release();
    } catch (const std::exception& error) {
        if (self->node) api->freeNode(self->node);
        api->mapSetError(out, (std::string("tigerest_vfg.Sample: ") + error.what()).c_str());
    }
}

struct Substitution { VSNode* node = nullptr; VSNode* original = nullptr; };

const VSFrame* VS_CC substituteFrame(int n, int activation, void* instance, void**, VSFrameContext* context, VSCore*, const VSAPI* api) {
    auto* self = static_cast<Substitution*>(instance);
    if (activation == arInitial) { api->requestFrameFilter(n, self->node, context); return nullptr; }
    if (activation != arAllFramesReady) return nullptr;
    const VSFrame* frame = api->getFrameFilter(n, self->node, context);
    if (!frame) return nullptr;
    if (integer(api, api->getFramePropertiesRO(frame), "_TigerestVfgGenerated", 1) != 0) return frame;
    api->freeFrame(frame);
    // Asked for only now, so a generated frame never waits for the original.
    if (const VSFrame* original = api->getFrameFilter(n, self->original, context)) return original;
    api->requestFrameFilter(n, self->original, context);
    return nullptr;
}

void VS_CC substituteFree(void* instance, VSCore*, const VSAPI* api) {
    auto* self = static_cast<Substitution*>(instance);
    api->freeNode(self->node);
    api->freeNode(self->original);
    delete self;
}

void VS_CC substituteCreate(const VSMap* in, VSMap* out, void*, VSCore* core, const VSAPI* api) {
    auto self = std::make_unique<Substitution>();
    self->node = api->mapGetNode(in, "clip", 0, nullptr);
    self->original = api->mapGetNode(in, "original", 0, nullptr);
    const VSVideoInfo* first = api->getVideoInfo(self->node);
    const VSVideoInfo* second = api->getVideoInfo(self->original);
    const bool same = first->format.colorFamily != cfUndefined && first->width > 0 && first->height > 0
        && first->width == second->width && first->height == second->height && first->numFrames <= second->numFrames
        && first->format.colorFamily == second->format.colorFamily && first->format.sampleType == second->format.sampleType
        && first->format.bitsPerSample == second->format.bitsPerSample
        && first->format.subSamplingW == second->format.subSamplingW && first->format.subSamplingH == second->format.subSamplingH;
    if (same) {
        VSFilterDependency dependencies[] = {{self->node, rpStrictSpatial}, {self->original, rpStrictSpatial}};
        api->createVideoFilter(out, "TigerestVfgSubstitute", first, substituteFrame, substituteFree, fmParallel, dependencies, 2, self.get(), core);
        if (!api->mapGetError(out)) { self.release(); return; }
    } else {
        api->mapSetError(out, "tigerest_vfg.Substitute: both clips need the same constant format and size, and original at least as many frames");
    }
    api->freeNode(self->node);
    api->freeNode(self->original);
}

}  // namespace

VS_EXTERNAL_API(void) VapourSynthPluginInit2(VSPlugin* plugin, const VSPLUGINAPI* api) {
    api->configPlugin("io.github.tigerest.vfg", "tigerest_vfg", "Tigerest NVIDIA Video Frame Generation",
                      VS_MAKE_VERSION(1, 0), VAPOURSYNTH_API_VERSION, 0, plugin);
    api->registerFunction("Interpolate",
                          "clip:vnode;runtime:data;fpsnum:int;fpsden:int;mode:int:opt;autoshot:int:opt;srcfpsnum:int:opt;srcfpsden:int:opt;"
                          "scenecut:float:opt;",
                          "clip:vnode;", interpolateCreate, nullptr, plugin);
    api->registerFunction("Sample", "clip:vnode;fpsnum:int;fpsden:int;hold:int:opt;srcfpsnum:int:opt;srcfpsden:int:opt;",
                          "clip:vnode;", sampleCreate, nullptr, plugin);
    api->registerFunction("Substitute", "clip:vnode;original:vnode;", "clip:vnode;", substituteCreate, nullptr, plugin);
}
