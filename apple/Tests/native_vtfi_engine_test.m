// Checks TigerestVTInterpolator on this Mac with synthetic frames: a moving
// pattern must land between its two positions, identical frames must come
// back unchanged, outputs keep the source's format and colour attachments,
// and the frame comparison tells a held drawing, motion and a cut apart.
#import <Foundation/Foundation.h>
#import <CoreVideo/CoreVideo.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include "TigerestVTInterpolator.h"

static int failures;
#define CHECK(cond, ...) do { if (!(cond)) { failures++; fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); fprintf(stderr, __VA_ARGS__); fprintf(stderr, "\n"); } } while (0)

static const int W = 1280, H = 720;

// Smooth texture plus a bright square at x0; luma in video range.
static uint8_t luma(int x, int y, int x0, int seed)
{
    double v = 110 + 40 * sin((x + seed) / 23.0) * cos(y / 19.0) + 20 * sin((x + y) / 31.0);
    if (x >= x0 && x < x0 + 160 && y >= 260 && y < 420)
        v = 210;
    return (uint8_t)fmin(235, fmax(16, v));
}

static CVPixelBufferRef frame(OSType format, int shift, int seed)
{
    NSDictionary *attributes = @{(id)kCVPixelBufferIOSurfacePropertiesKey: @{},
                                 (id)kCVPixelBufferMetalCompatibilityKey: @YES};
    CVPixelBufferRef buffer = NULL;
    if (CVPixelBufferCreate(NULL, W, H, format, (__bridge CFDictionaryRef)attributes, &buffer) != kCVReturnSuccess)
        return NULL;
    CVBufferSetAttachment(buffer, kCVImageBufferColorPrimariesKey, kCVImageBufferColorPrimaries_ITU_R_709_2, kCVAttachmentMode_ShouldPropagate);
    CVBufferSetAttachment(buffer, kCVImageBufferTransferFunctionKey, kCVImageBufferTransferFunction_ITU_R_709_2, kCVAttachmentMode_ShouldPropagate);
    CVBufferSetAttachment(buffer, kCVImageBufferYCbCrMatrixKey, kCVImageBufferYCbCrMatrix_ITU_R_709_2, kCVAttachmentMode_ShouldPropagate);
    CVPixelBufferLockBaseAddress(buffer, 0);
    const bool wide = format == kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange;
    uint8_t *y = CVPixelBufferGetBaseAddressOfPlane(buffer, 0), *uv = CVPixelBufferGetBaseAddressOfPlane(buffer, 1);
    const size_t ys = CVPixelBufferGetBytesPerRowOfPlane(buffer, 0), uvs = CVPixelBufferGetBytesPerRowOfPlane(buffer, 1);
    for (int r = 0; r < H; r++)
        for (int c = 0; c < W; c++) {
            const uint8_t v = luma(c, r, 400 + shift, seed);
            if (wide) ((uint16_t *)(y + ys * r))[c] = (uint16_t)(v << 8);
            else y[ys * r + c] = v;
        }
    for (int r = 0; r < H / 2; r++)
        for (int c = 0; c < W / 2; c++) {
            const uint8_t u = (uint8_t)(128 + ((c + shift / 2) % 64 < 32 ? 12 : -12)), v = 128;
            if (wide) { ((uint16_t *)(uv + uvs * r))[2 * c] = (uint16_t)(u << 8); ((uint16_t *)(uv + uvs * r))[2 * c + 1] = (uint16_t)(v << 8); }
            else { uv[uvs * r + 2 * c] = u; uv[uvs * r + 2 * c + 1] = v; }
        }
    CVPixelBufferUnlockBaseAddress(buffer, 0);
    return buffer;
}

static double psnr(CVPixelBufferRef a, CVPixelBufferRef b)
{
    CVPixelBufferLockBaseAddress(a, kCVPixelBufferLock_ReadOnly);
    CVPixelBufferLockBaseAddress(b, kCVPixelBufferLock_ReadOnly);
    const bool wide = CVPixelBufferGetPixelFormatType(a) == kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange;
    const uint8_t *pa = CVPixelBufferGetBaseAddressOfPlane(a, 0), *pb = CVPixelBufferGetBaseAddressOfPlane(b, 0);
    const size_t sa = CVPixelBufferGetBytesPerRowOfPlane(a, 0), sb = CVPixelBufferGetBytesPerRowOfPlane(b, 0);
    double sum = 0;
    for (int r = 0; r < H; r++)
        for (int c = 0; c < W; c++) {
            const double x = wide ? ((const uint16_t *)(pa + sa * r))[c] / 256.0 : pa[sa * r + c];
            const double z = wide ? ((const uint16_t *)(pb + sb * r))[c] / 256.0 : pb[sb * r + c];
            sum += (x - z) * (x - z);
        }
    CVPixelBufferUnlockBaseAddress(b, kCVPixelBufferLock_ReadOnly);
    CVPixelBufferUnlockBaseAddress(a, kCVPixelBufferLock_ReadOnly);
    const double mse = sum / ((double)W * H);
    return mse <= 1e-9 ? 99 : 10 * log10(255.0 * 255.0 / mse);
}

static void run(int mode, OSType format, const char *name)
{
    if (!tgvt_mode_supported(mode)) {
        printf("skip %s: not offered here\n", name);
        return;
    }
    char error[200] = "";
    tgvt_engine *engine = tgvt_create(mode, W, H, 1, error, sizeof(error));
    CHECK(engine, "%s: create failed: %s", name, error);
    if (!engine)
        return;
    CVPixelBufferRef a = frame(format, 0, 0), b = frame(format, 24, 0), truth = frame(format, 12, 0);
    const float half = 0.5f;
    CVPixelBufferRef out = NULL;
    double ms = 0;
    bool ok = tgvt_interpolate(engine, a, 1.0, b, 1.0 + 1 / 24.0, &half, 1, &out, &ms, error, sizeof(error));
    CHECK(ok && out, "%s: interpolate failed: %s", name, error);
    if (ok && out) {
        CHECK(CVPixelBufferGetPixelFormatType(out) == format, "%s: output format changed", name);
        CHECK((int)CVPixelBufferGetWidth(out) == W && (int)CVPixelBufferGetHeight(out) == H, "%s: output size changed", name);
        CFTypeRef matrix = CVBufferCopyAttachment(out, kCVImageBufferYCbCrMatrixKey, NULL);
        CHECK(matrix && CFEqual(matrix, kCVImageBufferYCbCrMatrix_ITU_R_709_2), "%s: colour attachments lost", name);
        if (matrix) CFRelease(matrix);
        const double mid = psnr(out, truth), early = psnr(out, a), late = psnr(out, b);
        printf("%s: %.1f ms, midpoint %.1f dB (earlier %.1f, later %.1f)\n", name, ms, mid, early, late);
        CHECK(mid > early + 3 && mid > late + 3 && mid > 28, "%s: the result is not between the two frames", name);
        CVPixelBufferRelease(out);
    }
    // The next pair continues the sequence from the cached later frame.
    CVPixelBufferRef c = frame(format, 48, 0), truth2 = frame(format, 36, 0);
    out = NULL;
    ok = tgvt_interpolate(engine, b, 1.0 + 1 / 24.0, c, 1.0 + 2 / 24.0, &half, 1, &out, &ms, error, sizeof(error));
    CHECK(ok && out, "%s: second pair failed: %s", name, error);
    if (ok && out) {
        const double mid = psnr(out, truth2);
        printf("%s: second pair %.1f ms, midpoint %.1f dB\n", name, ms, mid);
        CHECK(mid > 28, "%s: second pair is not between its frames", name);
        CVPixelBufferRelease(out);
    }
    // Identical frames come back unchanged (round trip through the work format).
    out = NULL;
    ok = tgvt_interpolate(engine, a, 5.0, a, 5.0 + 1 / 24.0, &half, 1, &out, &ms, error, sizeof(error));
    CHECK(ok && out, "%s: identity pair failed: %s", name, error);
    if (ok && out) {
        const double same = psnr(out, a);
        printf("%s: identical frames %.1f dB\n", name, same);
        CHECK(same > 38, "%s: identical frames changed (%.1f dB)", name, same);
        CVPixelBufferRelease(out);
    }
    CVPixelBufferRelease(a); CVPixelBufferRelease(b); CVPixelBufferRelease(c);
    CVPixelBufferRelease(truth); CVPixelBufferRelease(truth2);
    tgvt_destroy(engine);
}

static void compare(void)
{
    CVPixelBufferRef a = frame(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, 0, 0);
    CVPixelBufferRef same = frame(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, 0, 0);
    CVPixelBufferRef moved = frame(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, 12, 0);
    CVPixelBufferRef other = frame(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, 300, 900);
    double mean = 0, changed = 0, histogram = 0;
    CHECK(tgvt_compare(a, same, &mean, &changed, &histogram) && changed == 0 && mean == 0, "identical frames differ");
    CHECK(tgvt_compare(a, moved, &mean, &changed, &histogram) && changed > 0.0005 && mean < 0.12, "motion: changed %.4f mean %.3f", changed, mean);
    printf("motion: mean %.3f changed %.3f histogram %.3f\n", mean, changed, histogram);
    // A different scene: invert the picture.
    CVPixelBufferLockBaseAddress(other, 0);
    uint8_t *y = CVPixelBufferGetBaseAddressOfPlane(other, 0);
    const size_t ys = CVPixelBufferGetBytesPerRowOfPlane(other, 0);
    for (int r = 0; r < H; r++)
        for (int c = 0; c < W; c++)
            y[ys * r + c] = (uint8_t)(251 - y[ys * r + c]);
    CVPixelBufferUnlockBaseAddress(other, 0);
    CHECK(tgvt_compare(a, other, &mean, &changed, &histogram) && (mean > 0.25 || (mean > 0.12 && histogram > 0.6)),
          "cut not recognised: mean %.3f histogram %.3f", mean, histogram);
    printf("cut: mean %.3f changed %.3f histogram %.3f\n", mean, changed, histogram);
    CVPixelBufferRelease(a); CVPixelBufferRelease(same); CVPixelBufferRelease(moved); CVPixelBufferRelease(other);
}

int main(void)
{
    @autoreleasepool {
        CHECK(tgvt_size_supported(TGVT_MODE_EFFICIENT, 1920, 1080) && !tgvt_size_supported(TGVT_MODE_EFFICIENT, 1920, 1200),
              "efficient size limit");
        CHECK(tgvt_size_supported(TGVT_MODE_QUALITY, 1920, 1200) && !tgvt_size_supported(TGVT_MODE_QUALITY, 2560, 1440),
              "quality size limit");
        compare();
        run(TGVT_MODE_QUALITY, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, "quality 8-bit");
        run(TGVT_MODE_QUALITY, kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange, "quality 10-bit");
        run(TGVT_MODE_EFFICIENT, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange, "efficient 8-bit");
        run(TGVT_MODE_EFFICIENT, kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange, "efficient 10-bit");
    }
    if (failures)
        fprintf(stderr, "%d check(s) failed\n", failures);
    else
        printf("all checks passed\n");
    return failures ? 1 : 0;
}
