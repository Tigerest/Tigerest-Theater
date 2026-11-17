// See TigerestVTInterpolator.h. Builds with ARC (the iOS and tvOS apps) and
// without it (mpv's own Objective-C sources on macOS): Objective-C objects are
// held as Core Foundation references and every temporary lives in a pool.
#import <Foundation/Foundation.h>
#import <CoreVideo/CoreVideo.h>
#import <VideoToolbox/VideoToolbox.h>
#import <VideoToolbox/VTFrameProcessor.h>
#import <VideoToolbox/VTFrameProcessor_LowLatencyFrameInterpolation.h>
#if !TARGET_OS_TV
#import <VideoToolbox/VTFrameProcessor_FrameRateConversion.h>
#endif
#include <mach/mach_time.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "TigerestVTInterpolator.h"

#if __has_feature(objc_arc)
#define TG_AUTORELEASE(x) (x)
#else
#define TG_AUTORELEASE(x) [(x) autorelease]
#endif

struct tgvt_engine {
    int mode, width, height, points;
    CFTypeRef processor;              // VTFrameProcessor *
    CFTypeRef configuration;          // its configuration
    VTPixelTransferSessionRef transfer;
    OSType work_format;               // what the processor reads and writes
    CVPixelBufferPoolRef work_pool;   // converted inputs
    CVPixelBufferPoolRef dest_pool;   // processor outputs
    CVPixelBufferPoolRef out_pool;    // outputs converted back to the source's format
    OSType out_format;
    int out_width, out_height;
    // The converted copy of the last pair's later frame, for the next pair.
    CVPixelBufferRef cached;
    double cached_pts;
    double last_next_pts;
    bool have_last;
};

static void fail(char *error, size_t size, const char *text)
{
    if (error && size)
        snprintf(error, size, "%s", text);
}

static void fail_ns(char *error, size_t size, const char *what, NSError *err)
{
    if (!error || !size)
        return;
    const char *detail = err ? err.localizedDescription.UTF8String : NULL;
    snprintf(error, size, "%s (%ld%s%s)", what, err ? (long)err.code : 0L,
             detail ? ": " : "", detail ? detail : "");
}

static double now_ms(void)
{
    static mach_timebase_info_data_t base;
    if (!base.denom)
        mach_timebase_info(&base);
    return (double)mach_absolute_time() * base.numer / base.denom / 1e6;
}

bool tgvt_mode_supported(int mode)
{
    @autoreleasepool {
        if (mode == TGVT_MODE_EFFICIENT)
            return VTLowLatencyFrameInterpolationConfiguration.isSupported;
#if !TARGET_OS_TV
        if (mode == TGVT_MODE_QUALITY)
            return VTFrameRateConversionConfiguration.isSupported;
#endif
        return false;
    }
}

bool tgvt_size_supported(int mode, int width, int height)
{
    if (width < 64 || height < 64)
        return false;
    if (mode == TGVT_MODE_EFFICIENT)
        return width <= 1920 && height <= 1080;
    // 1920x1200 and narrower scopes in a 2048 container still keep 24 fps.
    return mode == TGVT_MODE_QUALITY && width <= 2048 && height <= 1200 &&
           (long)width * height <= 1920L * 1200L;
}

int tgvt_mode(const tgvt_engine *engine)
{
    return engine ? engine->mode : 0;
}

static CVPixelBufferPoolRef make_pool(NSDictionary *attributes, int count)
{
    CVPixelBufferPoolRef pool = NULL;
    NSDictionary *pool_attributes = @{(id)kCVPixelBufferPoolMinimumBufferCountKey: @(count)};
    if (CVPixelBufferPoolCreate(kCFAllocatorDefault, (__bridge CFDictionaryRef)pool_attributes,
                                (__bridge CFDictionaryRef)attributes, &pool) != kCVReturnSuccess)
        return NULL;
    return pool;
}

void tgvt_destroy(tgvt_engine *engine)
{
    if (!engine)
        return;
    @autoreleasepool {
        if (engine->processor)
            [(__bridge VTFrameProcessor *)engine->processor endSession];
    }
    if (engine->processor)
        CFRelease(engine->processor);
    if (engine->configuration)
        CFRelease(engine->configuration);
    if (engine->transfer) {
        VTPixelTransferSessionInvalidate(engine->transfer);
        CFRelease(engine->transfer);
    }
    CVPixelBufferRelease(engine->cached);
    CVPixelBufferPoolRelease(engine->work_pool);
    CVPixelBufferPoolRelease(engine->dest_pool);
    CVPixelBufferPoolRelease(engine->out_pool);
    free(engine);
}

tgvt_engine *tgvt_create(int mode, int width, int height, int points, char *error, size_t error_size)
{
    if (!tgvt_mode_supported(mode)) {
        fail(error, error_size, "this device does not offer the frame processor");
        return NULL;
    }
    if (!tgvt_size_supported(mode, width, height)) {
        fail(error, error_size, "unsupported frame size");
        return NULL;
    }
    if (mode == TGVT_MODE_EFFICIENT && points != 1 && points != 2) {
        fail(error, error_size, "efficient mode takes 1 or 2 points");
        return NULL;
    }
    tgvt_engine *engine = calloc(1, sizeof(*engine));
    if (!engine) {
        fail(error, error_size, "out of memory");
        return NULL;
    }
    engine->mode = mode;
    engine->width = width;
    engine->height = height;
    engine->points = points;
    @autoreleasepool {
        id<VTFrameProcessorConfiguration> configuration = nil;
        NSDictionary *source = nil, *destination = nil;
        if (mode == TGVT_MODE_EFFICIENT) {
            VTLowLatencyFrameInterpolationConfiguration *c = TG_AUTORELEASE(
                [[VTLowLatencyFrameInterpolationConfiguration alloc] initWithFrameWidth:width
                                                                            frameHeight:height
                                                             numberOfInterpolatedFrames:points]);
            configuration = c;
            source = c.sourcePixelBufferAttributes;
            destination = c.destinationPixelBufferAttributes;
        }
#if !TARGET_OS_TV
        else {
            VTFrameRateConversionConfiguration *c = TG_AUTORELEASE(
                [[VTFrameRateConversionConfiguration alloc] initWithFrameWidth:width
                                                                   frameHeight:height
                                                            usePrecomputedFlow:NO
                                                         qualityPrioritization:VTFrameRateConversionConfigurationQualityPrioritizationNormal
                                                                      revision:VTFrameRateConversionConfiguration.defaultRevision]);
            configuration = c;
            source = c.sourcePixelBufferAttributes;
            destination = c.destinationPixelBufferAttributes;
        }
#endif
        if (!configuration || !source || !destination) {
            fail(error, error_size, "the frame processor rejected this configuration");
            tgvt_destroy(engine);
            return NULL;
        }
        NSNumber *format = source[(id)kCVPixelBufferPixelFormatTypeKey];
        if ([format isKindOfClass:NSArray.class])
            format = [(NSArray *)format firstObject];
        engine->work_format = (OSType)format.unsignedIntValue;
        VTFrameProcessor *processor = TG_AUTORELEASE([[VTFrameProcessor alloc] init]);
        NSError *err = nil;
        if (![processor startSessionWithConfiguration:configuration error:&err]) {
            fail_ns(error, error_size, "the frame processor did not start", err);
            tgvt_destroy(engine);
            return NULL;
        }
        engine->processor = CFBridgingRetain(processor);
        engine->configuration = CFBridgingRetain(configuration);
        // A pair holds two inputs and the cached later frame; outputs are
        // copied back to the source's format before the next call.
        engine->work_pool = make_pool(source, 3);
        engine->dest_pool = make_pool(destination, 4);
        if (!engine->work_pool || !engine->dest_pool) {
            fail(error, error_size, "could not allocate frame buffers");
            tgvt_destroy(engine);
            return NULL;
        }
        if (VTPixelTransferSessionCreate(kCFAllocatorDefault, &engine->transfer) != noErr) {
            fail(error, error_size, "could not create a pixel transfer session");
            tgvt_destroy(engine);
            return NULL;
        }
        VTSessionSetProperty(engine->transfer, kVTPixelTransferPropertyKey_RealTime, kCFBooleanTrue);
    }
    return engine;
}

// The source's colour description travels with every copy, so each
// conversion uses the same matrix in both directions and the round trip
// returns the source's code values (VideoToolbox picks the same default when
// the decoder attached none).
static void copy_attachments(CVPixelBufferRef from, CVPixelBufferRef to)
{
    CFDictionaryRef attachments = CVBufferCopyAttachments(from, kCVAttachmentMode_ShouldPropagate);
    CVBufferRemoveAllAttachments(to);
    if (attachments) {
        CVBufferSetAttachments(to, attachments, kCVAttachmentMode_ShouldPropagate);
        CFRelease(attachments);
    }
}

// next's frame in the processor's format: itself when it already matches,
// else a converted copy from the pool (+1 retained either way).
static CVPixelBufferRef convert_input(tgvt_engine *e, CVPixelBufferRef frame)
{
    if (CVPixelBufferGetPixelFormatType(frame) == e->work_format &&
        (int)CVPixelBufferGetWidth(frame) == e->width && (int)CVPixelBufferGetHeight(frame) == e->height &&
        CVPixelBufferGetIOSurface(frame))
        return CVPixelBufferRetain(frame);
    CVPixelBufferRef copy = NULL;
    if (CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, e->work_pool, &copy) != kCVReturnSuccess)
        return NULL;
    copy_attachments(frame, copy);
    if (VTPixelTransferSessionTransferImage(e->transfer, frame, copy) != noErr) {
        CVPixelBufferRelease(copy);
        return NULL;
    }
    return copy;
}

static bool ensure_out_pool(tgvt_engine *e, CVPixelBufferRef like)
{
    const OSType format = CVPixelBufferGetPixelFormatType(like);
    const int w = (int)CVPixelBufferGetWidth(like), h = (int)CVPixelBufferGetHeight(like);
    if (e->out_pool && e->out_format == format && e->out_width == w && e->out_height == h)
        return true;
    CVPixelBufferPoolRelease(e->out_pool);
    e->out_pool = NULL;
    @autoreleasepool {
        NSDictionary *attributes = @{
            (id)kCVPixelBufferPixelFormatTypeKey: @(format),
            (id)kCVPixelBufferWidthKey: @(w),
            (id)kCVPixelBufferHeightKey: @(h),
            (id)kCVPixelBufferIOSurfacePropertiesKey: @{},
            (id)kCVPixelBufferMetalCompatibilityKey: @YES,
        };
        // Up to five frames per pair wait in mpv's queues before display.
        e->out_pool = make_pool(attributes, 12);
    }
    e->out_format = format;
    e->out_width = w;
    e->out_height = h;
    return e->out_pool != NULL;
}

static CMTime timestamp(double seconds)
{
    return CMTimeMakeWithSeconds(isfinite(seconds) ? seconds : 0, 90000);
}

bool tgvt_interpolate(tgvt_engine *e, CVPixelBufferRef prev, double prev_pts,
                      CVPixelBufferRef next, double next_pts, const float *phases, int count,
                      CVPixelBufferRef *out, double *ms, char *error, size_t error_size)
{
    if (!e || !prev || !next || !phases || !out || count < 1 || count > 8) {
        fail(error, error_size, "invalid request");
        return false;
    }
    for (int i = 0; i < count; i++)
        out[i] = NULL;
    const double start = now_ms();
    if (!ensure_out_pool(e, next)) {
        fail(error, error_size, "could not allocate output buffers");
        return false;
    }
    CVPixelBufferRef work_prev = NULL, work_next = NULL;
    CVPixelBufferRef dest[8] = {0};
    bool ok = false;
    @autoreleasepool {
        // One pass; every failure leaves it with break (a goto must not jump
        // over the initialisation of an ARC-managed object).
        do {
            const bool sequential = e->have_last && e->cached && e->cached_pts == prev_pts && e->last_next_pts == prev_pts;
            work_prev = sequential ? CVPixelBufferRetain(e->cached) : convert_input(e, prev);
            work_next = convert_input(e, next);
            if (!work_prev || !work_next) {
                fail(error, error_size, "could not convert the frames");
                break;
            }
            NSMutableArray *destinations = [NSMutableArray arrayWithCapacity:count];
            NSMutableArray *phase_list = [NSMutableArray arrayWithCapacity:count];
            bool prepared = true;
            for (int i = 0; i < count && prepared; i++) {
                if (CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, e->dest_pool, &dest[i]) != kCVReturnSuccess) {
                    fail(error, error_size, "could not allocate interpolated frames");
                    prepared = false;
                    break;
                }
                copy_attachments(next, dest[i]);
                const double t = prev_pts + (next_pts - prev_pts) * phases[i];
                VTFrameProcessorFrame *frame = TG_AUTORELEASE([[VTFrameProcessorFrame alloc] initWithBuffer:dest[i]
                                                                                presentationTimeStamp:timestamp(t)]);
                if (!frame) {
                    fail(error, error_size, "an interpolated frame is not IOSurface-backed");
                    prepared = false;
                    break;
                }
                [destinations addObject:frame];
                [phase_list addObject:@(phases[i])];
            }
            if (!prepared)
                break;
            VTFrameProcessorFrame *earlier = TG_AUTORELEASE([[VTFrameProcessorFrame alloc] initWithBuffer:work_prev
                                                                              presentationTimeStamp:timestamp(prev_pts)]);
            VTFrameProcessorFrame *later = TG_AUTORELEASE([[VTFrameProcessorFrame alloc] initWithBuffer:work_next
                                                                            presentationTimeStamp:timestamp(next_pts)]);
            if (!earlier || !later) {
                fail(error, error_size, "a source frame is not IOSurface-backed");
                break;
            }
            id<VTFrameProcessorParameters> parameters = nil;
            if (e->mode == TGVT_MODE_EFFICIENT) {
                parameters = TG_AUTORELEASE([[VTLowLatencyFrameInterpolationParameters alloc] initWithSourceFrame:later
                                                                                                    previousFrame:earlier
                                                                                               interpolationPhase:phase_list
                                                                                                destinationFrames:destinations]);
            }
#if !TARGET_OS_TV
            else {
                const VTFrameRateConversionParametersSubmissionMode submission = sequential
                    ? VTFrameRateConversionParametersSubmissionModeSequential
                    : VTFrameRateConversionParametersSubmissionModeRandom;
                parameters = TG_AUTORELEASE([[VTFrameRateConversionParameters alloc] initWithSourceFrame:earlier
                                                                                               nextFrame:later
                                                                                             opticalFlow:nil
                                                                                      interpolationPhase:phase_list
                                                                                          submissionMode:submission
                                                                                       destinationFrames:destinations]);
            }
#endif
            if (!parameters) {
                fail(error, error_size, "the frame processor rejected these frames");
                break;
            }
            NSError *err = nil;
            if (![(__bridge VTFrameProcessor *)e->processor processWithParameters:parameters error:&err]) {
                fail_ns(error, error_size, "interpolation failed", err);
                break;
            }
            bool converted = true;
            for (int i = 0; i < count; i++) {
                CVPixelBufferRef result = NULL;
                if (CVPixelBufferGetPixelFormatType(dest[i]) == e->out_format &&
                    (int)CVPixelBufferGetWidth(dest[i]) == e->out_width &&
                    (int)CVPixelBufferGetHeight(dest[i]) == e->out_height) {
                    result = CVPixelBufferRetain(dest[i]);
                } else {
                    if (CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, e->out_pool, &result) != kCVReturnSuccess) {
                        fail(error, error_size, "could not allocate output buffers");
                        converted = false;
                        break;
                    }
                    copy_attachments(next, result);
                    if (VTPixelTransferSessionTransferImage(e->transfer, dest[i], result) != noErr) {
                        CVPixelBufferRelease(result);
                        fail(error, error_size, "could not convert an interpolated frame back");
                        converted = false;
                        break;
                    }
                }
                out[i] = result;
            }
            ok = converted;
        } while (0);
    }
    for (int i = 0; i < count; i++)
        CVPixelBufferRelease(dest[i]);
    if (!ok) {
        for (int i = 0; i < count; i++) {
            CVPixelBufferRelease(out[i]);
            out[i] = NULL;
        }
        CVPixelBufferRelease(work_prev);
        CVPixelBufferRelease(work_next);
        // The processor's history no longer matches; start over.
        CVPixelBufferRelease(e->cached);
        e->cached = NULL;
        e->have_last = false;
        return false;
    }
    CVPixelBufferRelease(work_prev);
    CVPixelBufferRelease(e->cached);
    e->cached = work_next;
    e->cached_pts = next_pts;
    e->last_next_pts = next_pts;
    e->have_last = true;
    if (ms)
        *ms = now_ms() - start;
    return true;
}

// Luma code value at a sample point, normalised to 0..1 of 8 or 16 bits.
static inline double luma_at(const uint8_t *row, int x, bool wide)
{
    return wide ? ((const uint16_t *)row)[x] / 65535.0 : row[x] / 255.0;
}

static bool luma_plane(CVPixelBufferRef frame, const uint8_t **base, size_t *stride, int *w, int *h, bool *wide)
{
    const OSType format = CVPixelBufferGetPixelFormatType(frame);
    switch (format) {
    case kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange:
    case kCVPixelFormatType_420YpCbCr8BiPlanarFullRange:
    case kCVPixelFormatType_420YpCbCr8Planar:
    case kCVPixelFormatType_420YpCbCr8PlanarFullRange:
        *wide = false;
        break;
    case kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange:
    case kCVPixelFormatType_420YpCbCr10BiPlanarFullRange:
    case kCVPixelFormatType_422YpCbCr10BiPlanarVideoRange:
    case kCVPixelFormatType_444YpCbCr10BiPlanarVideoRange:
        *wide = true;
        break;
    default:
        return false;
    }
    *base = CVPixelBufferGetBaseAddressOfPlane(frame, 0);
    *stride = CVPixelBufferGetBytesPerRowOfPlane(frame, 0);
    *w = (int)CVPixelBufferGetWidthOfPlane(frame, 0);
    *h = (int)CVPixelBufferGetHeightOfPlane(frame, 0);
    return *base && *w > 0 && *h > 0;
}

bool tgvt_compare(CVPixelBufferRef a, CVPixelBufferRef b, double *mean, double *changed, double *histogram)
{
    if (!a || !b)
        return false;
    if (CVPixelBufferLockBaseAddress(a, kCVPixelBufferLock_ReadOnly) != kCVReturnSuccess)
        return false;
    if (CVPixelBufferLockBaseAddress(b, kCVPixelBufferLock_ReadOnly) != kCVReturnSuccess) {
        CVPixelBufferUnlockBaseAddress(a, kCVPixelBufferLock_ReadOnly);
        return false;
    }
    const uint8_t *pa = NULL, *pb = NULL;
    size_t sa = 0, sb = 0;
    int wa = 0, ha = 0, wb = 0, hb = 0;
    bool xa = false, xb = false, ok = false;
    if (luma_plane(a, &pa, &sa, &wa, &ha, &xa) && luma_plane(b, &pb, &sb, &wb, &hb, &xb) &&
        wa == wb && ha == hb && xa == xb) {
        // 128x72 samples: a mouth flap or a blinking eye over 0.5 % of the
        // picture still lands on dozens of them.
        enum { GX = 128, GY = 72, BINS = 32 };
        double sum = 0;
        int moved = 0, count = 0;
        int ha_bins[BINS] = {0}, hb_bins[BINS] = {0};
        // Coded noise of a static anime frame stays within a few code values.
        const double noise = 4.0 / 255.0;
        for (int gy = 0; gy < GY; gy++) {
            const int y = (int)(((long)gy * 2 + 1) * ha / (GY * 2));
            const uint8_t *ra = pa + sa * y, *rb = pb + sb * y;
            for (int gx = 0; gx < GX; gx++) {
                const int x = (int)(((long)gx * 2 + 1) * wa / (GX * 2));
                const double va = luma_at(ra, x, xa), vb = luma_at(rb, x, xb);
                const double d = fabs(va - vb);
                sum += d;
                moved += d > noise;
                ha_bins[(int)fmin(BINS - 1, va * BINS)]++;
                hb_bins[(int)fmin(BINS - 1, vb * BINS)]++;
                count++;
            }
        }
        double distance = 0;
        for (int i = 0; i < BINS; i++)
            distance += fabs((double)ha_bins[i] - hb_bins[i]);
        // The video range spans 219 of 255 codes; scale to 0..1 of it.
        if (mean)
            *mean = sum / count * (255.0 / 219.0);
        if (changed)
            *changed = (double)moved / count;
        if (histogram)
            *histogram = distance / count;
        ok = true;
    }
    CVPixelBufferUnlockBaseAddress(b, kCVPixelBufferLock_ReadOnly);
    CVPixelBufferUnlockBaseAddress(a, kCVPixelBufferLock_ReadOnly);
    return ok;
}
