// Apple-native frame interpolation as an mpv 0.41 video filter:
//   --vf=@tigerest-vtfi:tigerest-vtfi=mode=quality:target=59.94
// It takes VideoToolbox hardware frames as they leave the decoder and hands
// back hardware frames on a regular output grid (factor x the source rate, or
// a target rate): source frames where the grid meets them, interpolated frames
// in between. VideoToolbox runs on a worker thread of this filter, never on
// mpv's playback thread. Built into the desktop libmpv on macOS and linked into
// the iOS and tvOS apps (see apple/tools); the engine is TigerestVTInterpolator.
#include <dispatch/dispatch.h>
#include <libavutil/buffer.h>
#include <math.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "common/tags.h"
#include "filters/f_async_queue.h"
#include "filters/filter_internal.h"
#include "filters/user_filters.h"
#include "misc/dispatch.h"
#include "options/m_config_core.h"
#include "options/m_option.h"
#include "options/options.h"
#include "osdep/threads.h"
#include "video/img_format.h"
#include "video/mp_image.h"
#include "TigerestVTInterpolator.h"

struct vtfi_opts {
    int mode;
    double factor;  // output rate as a multiple of the source rate
    double target;  // output rate in frames per second; 0 uses factor
};

#define OPT_BASE_STRUCT struct vtfi_opts
static const struct m_option vtfi_opts_list[] = {
    {"mode", OPT_CHOICE(mode, {"quality", TGVT_MODE_QUALITY}, {"efficient", TGVT_MODE_EFFICIENT})},
    {"factor", OPT_DOUBLE(factor), M_RANGE(1.5, 8)},
    {"target", OPT_DOUBLE(target), M_RANGE(0, 600)},
    {0}
};
static const struct vtfi_opts vtfi_opts_defaults = {
    .mode = TGVT_MODE_QUALITY,
    .factor = 2,
};

// Sources this filter interpolates. Faster ones keep their frames: a pair must
// finish within one source frame (22 ms for 1080p on an M4 Pro).
#define VTFI_MAX_SOURCE_FPS 30.01
#define VTFI_MAX_PER_PAIR 8
#define VTFI_QUEUE 24
#define VTFI_TIMINGS 180

// Built on a background queue: a session can take seconds to load its model.
// Both the filter and the job hold a reference; the last one frees it.
struct engine_job {
    atomic_int refs;
    atomic_bool done;
    int mode, w, h, points;
    tgvt_engine *engine;
    char error[160];
};

static void job_unref(struct engine_job *job)
{
    if (job && atomic_fetch_sub(&job->refs, 1) == 1) {
        tgvt_destroy(job->engine);
        free(job);
    }
}

static void job_run(void *arg)
{
    struct engine_job *job = arg;
    job->engine = tgvt_create(job->mode, job->w, job->h, job->points, job->error, sizeof(job->error));
    atomic_store(&job->done, true);
    job_unref(job);
}

struct core {
    struct vtfi_opts opts;
    struct m_config_cache *gopts;
    struct engine_job *job;
    tgvt_engine *engine;
    int engine_mode, engine_w, engine_h, engine_points;
    bool engine_failed;           // creation failed for this size
    // The output grid: anchor + k * period, the last time sent, the source
    // frame the next pair starts from.
    struct mp_image *prev;
    double anchor, period, rate, source_fps, last_pts;
    int points;                   // efficient mode: 1 (2x) or 2 (4x)
    struct mp_image *queue[VTFI_QUEUE];
    int queued;
    struct mp_frame signal;       // EOF waiting behind queued frames
    const char *status;
    bool failed, too_slow, speed_bypass;
    bool fell_back;               // the quality mode was too slow; efficient took over
    bool restart;                 // start a new sequence with the next frame
    char error[160];
    int64_t inputs, outputs, generated, held, statics, cuts, bypassed, failures, resets, pairs;
    double last_ms, timings[VTFI_TIMINGS];
    int timing_count, timing_next;
    // Throughput guard, in windows of about three seconds of source frames:
    // a window is slow when more than a fifth of the pairs that needed work
    // took longer than a source frame lasts (held drawings and cuts cost
    // nothing, so an average would hide a moving scene that cannot keep up;
    // the output queue absorbs the odd slow pair). Two slow windows in a row
    // hand over to the efficient mode, or stop.
    int window_pairs, window_real, window_over, slow_windows;
    // Tests only (TIGEREST_VTFI_TEST_EXTRA_MS): added to every measured pair,
    // so the throughput guard can be exercised on a fast machine.
    double test_extra_ms;
};

static double playback_speed(struct core *p)
{
    m_config_cache_update(p->gopts);
    return ((struct MPOpts *)p->gopts->opts)->playback_speed;
}

static void push(struct core *p, struct mp_image *img)
{
    if (!img)
        return;
    if (p->queued == VTFI_QUEUE) {
        // Cannot happen with at most eight frames per pair; never leak.
        talloc_free(img);
        return;
    }
    p->queue[p->queued++] = img;
}

static void forget_history(struct core *p)
{
    mp_image_unrefp(&p->prev);
    p->window_pairs = p->window_real = p->window_over = 0;
}

// Sends the last source frame, if the grid has not shown it yet, before a
// discontinuity, a bypassed frame or the end.
static void flush_prev(struct core *p)
{
    if (!p->prev)
        return;
    if (p->prev->pts > p->last_pts + 1e-6) {
        struct mp_image *img = mp_image_new_ref(p->prev);
        if (img) {
            img->pkt_duration = p->period;
            img->nominal_fps = p->rate;
            p->last_pts = img->pts;
            push(p, img);
        }
    }
    forget_history(p);
}

static void core_reset(struct mp_filter *f)
{
    struct core *p = f->priv;
    for (int i = 0; i < p->queued; i++)
        talloc_free(p->queue[i]);
    p->queued = 0;
    mp_frame_unref(&p->signal);
    forget_history(p);
    p->last_pts = -INFINITY;
    p->slow_windows = 0;
    p->resets++;
}

static void core_destroy(struct mp_filter *f)
{
    struct core *p = f->priv;
    core_reset(f);
    job_unref(p->job);
    p->job = NULL;
    tgvt_destroy(p->engine);
    p->engine = NULL;
}

static const char *ineligible(struct core *p, struct mp_image *img)
{
    if (img->imgfmt != IMGFMT_VIDEOTOOLBOX || !img->planes[3])
        return "needs-hardware-frames";
    if (!tgvt_mode_supported(p->opts.mode))
        return "unavailable";
    CVPixelBufferRef buffer = (CVPixelBufferRef)img->planes[3];
    const int w = (int)CVPixelBufferGetWidth(buffer), h = (int)CVPixelBufferGetHeight(buffer);
    if (!tgvt_size_supported(p->opts.mode, w, h))
        return "unsupported-size";
    if (!(img->nominal_fps > 0) || img->nominal_fps > VTFI_MAX_SOURCE_FPS)
        return "unsupported-fps";
    if (img->pts == MP_NOPTS_VALUE || !isfinite(img->pts))
        return "no-timestamps";
    if (img->fields & MP_IMGFIELD_INTERLACED)
        return "interlaced";
    const enum pl_color_transfer trc = img->params.color.transfer;
    if (trc == PL_COLOR_TRC_PQ || trc == PL_COLOR_TRC_HLG || img->params.repr.sys == PL_COLOR_SYSTEM_DOLBYVISION)
        return "hdr";
    return NULL;
}

// The engine for this frame's size, if one is ready; starts building it.
static bool engine_ready(struct core *p, struct mp_image *img)
{
    CVPixelBufferRef buffer = (CVPixelBufferRef)img->planes[3];
    const int w = (int)CVPixelBufferGetWidth(buffer), h = (int)CVPixelBufferGetHeight(buffer);
    const int points = p->opts.mode == TGVT_MODE_EFFICIENT ? p->points : 0;
    const bool same = p->engine_mode == p->opts.mode && p->engine_w == w && p->engine_h == h &&
                      p->engine_points == points;
    if (!same) {
        tgvt_destroy(p->engine);
        p->engine = NULL;
        job_unref(p->job);
        p->job = NULL;
        p->engine_failed = false;
        p->engine_mode = p->opts.mode;
        p->engine_w = w;
        p->engine_h = h;
        p->engine_points = points;
    }
    if (p->engine)
        return true;
    if (p->engine_failed)
        return false;
    if (!p->job) {
        struct engine_job *job = calloc(1, sizeof(*job));
        if (!job) {
            p->engine_failed = true;
            snprintf(p->error, sizeof(p->error), "out of memory");
            return false;
        }
        atomic_init(&job->refs, 2);
        atomic_init(&job->done, false);
        job->mode = p->opts.mode;
        job->w = w;
        job->h = h;
        job->points = points ? points : 1;
        p->job = job;
        dispatch_async_f(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), job, job_run);
        return false;
    }
    if (!atomic_load(&p->job->done))
        return false;
    p->engine = p->job->engine;
    p->job->engine = NULL;
    if (!p->engine) {
        p->engine_failed = true;
        snprintf(p->error, sizeof(p->error), "%s", p->job->error);
    }
    job_unref(p->job);
    p->job = NULL;
    return p->engine != NULL;
}

// The output rate for this source: the target, or factor x source. The
// efficient mode has 2x and 4x only.
static bool choose_rate(struct core *p, double fps)
{
    double rate = p->opts.factor * fps;
    if (p->opts.target > 0) {
        rate = p->opts.target;
        // A whole-number target (60, 120) belongs to the NTSC family of a
        // 23.976 or 29.97 fps source, so the pattern of phases repeats.
        const double ntsc = fps * 1.001;
        if (fabs(rate - round(rate)) < 1e-6 && fabs(ntsc - round(ntsc)) < 0.01 && fabs(fps - round(fps)) > 0.01)
            rate /= 1.001;
        // Five frames per source frame at most (120 Hz from 24 fps).
        rate = fmin(rate, fps * 5);
    }
    if (p->opts.mode == TGVT_MODE_EFFICIENT) {
        p->points = rate >= 3.5 * fps ? 2 : 1;
        rate = fps * (p->points == 2 ? 4 : 2);
    }
    // Fewer than 1.4 output frames per source frame would just repeat frames.
    if (!(rate >= fps * 1.4) || rate > 600)
        return false;
    p->source_fps = fps;
    p->rate = rate;
    p->period = 1.0 / rate;
    return true;
}

static void start(struct core *p, struct mp_image *img)
{
    p->anchor = img->pts;
    p->last_pts = img->pts;
    struct mp_image *out = mp_image_new_ref(img);
    if (out) {
        out->pkt_duration = p->period;
        out->nominal_fps = p->rate;
        push(p, out);
    }
    mp_image_unrefp(&p->prev);
    p->prev = img;
}

static void release_buffer(void *arg)
{
    CVPixelBufferRelease((CVPixelBufferRef)arg);
}

// A hardware frame for buffer, described like the source frame tmpl.
static struct mp_image *wrap(struct mp_image *tmpl, CVPixelBufferRef buffer, double pts, struct core *p)
{
    struct mp_image *img = mp_image_new_custom_ref(tmpl, buffer, release_buffer);
    if (!img)
        return NULL; // the buffer stays the caller's
    img->planes[3] = (uint8_t *)buffer;
    img->hwctx = tmpl->hwctx ? av_buffer_ref(tmpl->hwctx) : NULL;
    img->pts = pts;
    img->dts = MP_NOPTS_VALUE;
    img->pkt_duration = p->period;
    img->nominal_fps = p->rate;
    return img;
}

// Processing time of one pair; real is false for a held drawing or a cut.
// Only real work enters the timing statistics; the guard counts every pair.
static void record_time(struct core *p, double ms, bool real)
{
    const double budget = 1000.0 / p->source_fps;
    if (real) {
        ms += p->test_extra_ms;
        p->last_ms = ms;
        if (++p->pairs > 30 && isfinite(ms) && ms >= 0) {
            p->timings[p->timing_next] = ms;
            p->timing_next = (p->timing_next + 1) % VTFI_TIMINGS;
            if (p->timing_count < VTFI_TIMINGS)
                p->timing_count++;
        }
        p->window_real++;
        p->window_over += ms > budget;
    }
    if (++p->window_pairs >= (int)ceil(p->source_fps * 3)) {
        const bool slow = p->window_real >= 12 && p->window_over * 5 > p->window_real;
        p->slow_windows = slow ? p->slow_windows + 1 : 0;
        p->window_pairs = p->window_real = p->window_over = 0;
        if (p->slow_windows >= 2) {
            p->slow_windows = 0;
            // The lighter processor next, where the device has it and the
            // frames fit; failing that, the video's own frames.
            if (p->opts.mode == TGVT_MODE_QUALITY && tgvt_mode_supported(TGVT_MODE_EFFICIENT) &&
                tgvt_size_supported(TGVT_MODE_EFFICIENT, p->engine_w, p->engine_h)) {
                p->opts.mode = TGVT_MODE_EFFICIENT;
                p->fell_back = true;
                p->restart = true;
            } else {
                p->too_slow = true;
            }
        }
    }
}

static void handle_pair(struct core *p, struct mp_image *img)
{
    const double t0 = p->prev->pts, t1 = img->pts, dt = t1 - t0;
    const double half = p->period * 0.5;
    double times[VTFI_MAX_PER_PAIR + 2];
    float phases[VTFI_MAX_PER_PAIR + 2];
    bool original[VTFI_MAX_PER_PAIR + 2];
    int count = 0, wanted = 0;
    // Grid points in [t0 - half, t1 - half): each belongs to the source frame
    // within half an output period of it, or lies between the two.
    const double from = fmax(t0 - half, p->last_pts + 1e-6);
    for (long k = (long)ceil((from - p->anchor) / p->period - 1e-9); count < VTFI_MAX_PER_PAIR + 2; k++) {
        const double t = p->anchor + k * p->period;
        if (t >= t1 - half)
            break;
        if (t <= p->last_pts + 1e-6)
            continue;
        times[count] = t;
        original[count] = t - t0 < half;
        phases[count] = (float)fmin(0.99, fmax(0.01, (t - t0) / dt));
        if (p->opts.mode == TGVT_MODE_EFFICIENT && !original[count]) {
            // Its points are fixed; timestamps rounded by the container move
            // the grid a little, never by an eighth of a pair.
            const double steps = p->points == 2 ? 4 : 2;
            const double snapped = round(phases[count] * steps) / steps;
            if (snapped <= 0 || snapped >= 1 || fabs(snapped - phases[count]) > 0.125)
                original[count] = true;
            else
                phases[count] = (float)snapped;
        }
        wanted += !original[count];
        count++;
    }
    CVPixelBufferRef made[VTFI_MAX_PER_PAIR + 2] = {0};
    if (wanted) {
        CVPixelBufferRef a = (CVPixelBufferRef)p->prev->planes[3], b = (CVPixelBufferRef)img->planes[3];
        double mean = 1, changed = 1, histogram = 0;
        const bool compared = tgvt_compare(a, b, &mean, &changed, &histogram);
        if (compared && changed < 0.0005) {
            // A held drawing: the frame itself is the right in-between.
            p->statics++;
            record_time(p, 0, false);
        } else if (compared && (mean > 0.25 || (mean > 0.12 && histogram > 0.6))) {
            // A cut: hold the last frame of the old shot until the new one.
            p->cuts++;
            record_time(p, 0, false);
        } else {
            float list[VTFI_MAX_PER_PAIR + 2];
            int n = 0;
            for (int i = 0; i < count; i++)
                if (!original[i])
                    list[n++] = phases[i];
            CVPixelBufferRef result[VTFI_MAX_PER_PAIR + 2] = {0};
            double ms = 0;
            if (tgvt_interpolate(p->engine, a, t0, b, t1, list, n, result, &ms, p->error, sizeof(p->error))) {
                for (int i = 0, j = 0; i < count; i++)
                    if (!original[i])
                        made[i] = result[j++];
                record_time(p, ms, true);
            } else {
                // Keep playing the source frames; the next item tries again.
                p->failures++;
                p->failed = true;
            }
        }
    }
    for (int i = 0; i < count; i++) {
        struct mp_image *out = NULL;
        if (made[i]) {
            out = wrap(img, made[i], times[i], p);
            if (out)
                p->generated++;
            else
                CVPixelBufferRelease(made[i]);
        }
        if (!out) {
            // The earlier frame: a source frame on the grid, a held drawing,
            // a cut, or a failure.
            out = mp_image_new_ref(p->prev);
            if (!out)
                continue;
            out->pts = times[i];
            out->pkt_duration = p->period;
            out->nominal_fps = p->rate;
            if (!original[i])
                p->held++;
        }
        push(p, out);
        p->last_pts = times[i];
    }
    p->status = p->failed ? "failed" : "active";
}

static bool continues(struct core *p, struct mp_image *img)
{
    const double dt = img->pts - p->prev->pts;
    return mp_image_params_static_equal(&p->prev->params, &img->params) && dt > 0 &&
           dt < 2.5 / p->source_fps && fabs(img->nominal_fps - p->source_fps) < 0.01;
}

// Takes img.
static void handle(struct core *p, struct mp_image *img)
{
    p->inputs++;
    const char *why = ineligible(p, img);
    const bool speed = playback_speed(p) > 1.0001;
    if (speed != p->speed_bypass) {
        flush_prev(p);
        p->speed_bypass = speed;
    }
    if (p->restart) {
        // The mode changed: the new one chooses its own rate and engine.
        p->restart = false;
        flush_prev(p);
    }
    if (!why && !p->failed && !p->too_slow && !speed) {
        if (p->prev && !continues(p, img))
            flush_prev(p);
        // A new sequence chooses its rate first: the efficient engine's
        // points depend on it.
        if (!p->prev && !choose_rate(p, img->nominal_fps))
            why = "target-not-higher";
        else if (!engine_ready(p, img))
            why = p->engine_failed ? "unavailable" : "preparing";
    }
    if (why || p->failed || p->too_slow || speed) {
        flush_prev(p);
        p->status = p->failed ? "failed" : p->too_slow ? "too-slow" : speed ? "speed-bypass" : why;
        p->bypassed++;
        push(p, img);
        return;
    }
    if (p->prev) {
        handle_pair(p, img);
        mp_image_unrefp(&p->prev);
        p->prev = img;
    } else {
        start(p, img);
        p->status = "warming";
    }
}

static bool send_one(struct mp_filter *f)
{
    struct core *p = f->priv;
    if (p->queued) {
        struct mp_image *img = p->queue[0];
        memmove(p->queue, p->queue + 1, sizeof(p->queue[0]) * --p->queued);
        p->outputs++;
        mp_pin_in_write(f->ppins[1], MAKE_FRAME(MP_FRAME_VIDEO, img));
        return true;
    }
    if (p->signal.type != MP_FRAME_NONE) {
        struct mp_frame signal = p->signal;
        p->signal = MP_NO_FRAME;
        mp_pin_in_write(f->ppins[1], signal);
        return true;
    }
    return false;
}

static void core_process(struct mp_filter *f)
{
    struct core *p = f->priv;
    if (!mp_pin_in_needs_data(f->ppins[1]))
        return;
    if (send_one(f))
        return;
    struct mp_frame frame = mp_pin_out_read(f->ppins[0]);
    if (frame.type == MP_FRAME_NONE)
        return;
    if (frame.type == MP_FRAME_VIDEO) {
        handle(p, frame.data);
    } else {
        // EOF and other signals go after the last source frame.
        flush_prev(p);
        p->last_pts = -INFINITY;
        p->signal = frame;
    }
    send_one(f);
}

static int compare_ms(const void *a, const void *b)
{
    const double x = *(const double *)a, y = *(const double *)b;
    return (x > y) - (x < y);
}

static double p95_ms(struct core *p)
{
    if (!p->timing_count)
        return 0;
    double sorted[VTFI_TIMINGS];
    memcpy(sorted, p->timings, sizeof(double) * p->timing_count);
    qsort(sorted, p->timing_count, sizeof(double), compare_ms);
    return sorted[(int)ceil(p->timing_count * .95) - 1];
}

static bool core_command(struct mp_filter *f, struct mp_filter_command *cmd)
{
    if (cmd->type != MP_FILTER_COMMAND_GET_META)
        return false;
    struct core *p = f->priv;
    struct mp_tags *tags = talloc_zero(NULL, struct mp_tags);
    mp_tags_set_str(tags, "status", p->status ? p->status : "waiting");
    mp_tags_set_str(tags, "mode", p->opts.mode == TGVT_MODE_EFFICIENT ? "efficient" : "quality");
    if (p->fell_back)
        mp_tags_set_str(tags, "fallback", "efficient");
#define STAT(n) mp_tags_set_str(tags, #n, mp_tprintf(32, "%lld", (long long)p->n))
    STAT(inputs);
    STAT(outputs);
    STAT(generated);
    STAT(held);
    STAT(statics);
    STAT(cuts);
    STAT(bypassed);
    STAT(failures);
    STAT(resets);
    STAT(pairs);
#undef STAT
    mp_tags_set_str(tags, "sourceFps", mp_tprintf(32, "%.6f", p->source_fps));
    mp_tags_set_str(tags, "outputFps", mp_tprintf(32, "%.6f", p->rate));
    mp_tags_set_str(tags, "processMs", mp_tprintf(32, "%.3f", p->last_ms));
    mp_tags_set_str(tags, "processP95Ms", mp_tprintf(32, "%.3f", p95_ms(p)));
    if (p->error[0])
        mp_tags_set_str(tags, "error", p->error);
    *(struct mp_tags **)cmd->res = tags;
    return true;
}

static const struct mp_filter_info core_info = {
    .name = "tigerest-vtfi-core",
    .priv_size = sizeof(struct core),
    .process = core_process,
    .reset = core_reset,
    .destroy = core_destroy,
    .command = core_command,
};

static struct mp_filter *core_create(struct mp_filter *parent, const struct vtfi_opts *opts)
{
    struct mp_filter *f = mp_filter_create(parent, &core_info);
    if (!f)
        return NULL;
    mp_filter_add_pin(f, MP_PIN_IN, "in");
    mp_filter_add_pin(f, MP_PIN_OUT, "out");
    struct core *p = f->priv;
    p->opts = *opts;
    p->gopts = m_config_cache_alloc(p, f->global, &mp_opt_root);
    p->last_pts = -INFINITY;
    p->signal = MP_NO_FRAME;
    p->status = "waiting";
    const char *extra = getenv("TIGEREST_VTFI_TEST_EXTRA_MS");
    p->test_extra_ms = extra ? fmax(0, atof(extra)) : 0;
    return f;
}

// The core runs in a filter graph of its own on a worker thread, joined to
// mpv's graph by two bounded queues (the pattern of the iPad RIFE filter).
struct async_priv {
    struct mp_filter *root, *core, *input_writer, *output_reader;
    struct mp_async_queue *input, *output;
    struct mp_dispatch_queue *dispatch;
    mp_thread thread;
    bool thread_valid, primed, input_eof;
    atomic_bool terminate;
    mp_mutex metadata_lock;
    struct mp_tags *metadata;
};

static void wakeup_worker(void *ptr)
{
    struct async_priv *p = ptr;
    mp_dispatch_interrupt(p->dispatch);
}

static void interrupt_worker(void *ptr)
{
    struct async_priv *p = ptr;
    mp_filter_graph_interrupt(p->root);
}

static MP_THREAD_VOID worker(void *ptr)
{
    struct async_priv *p = ptr;
    mp_thread_set_name("vtfi/video");
    while (!atomic_load(&p->terminate)) {
        mp_filter_graph_run(p->root);
        struct mp_tags *next = NULL;
        struct mp_filter_command cmd = {.type = MP_FILTER_COMMAND_GET_META, .res = &next};
        mp_filter_command(p->core, &cmd);
        mp_mutex_lock(&p->metadata_lock);
        talloc_free(p->metadata);
        p->metadata = next;
        mp_mutex_unlock(&p->metadata_lock);
        mp_dispatch_queue_process(p->dispatch, INFINITY);
    }
    MP_THREAD_RETURN();
}

static void async_process(struct mp_filter *f)
{
    struct async_priv *p = f->priv;
    if (mp_pin_in_needs_data(p->input_writer->pins[0])) {
        struct mp_frame frame = mp_pin_out_read(f->ppins[0]);
        if (frame.type != MP_FRAME_NONE) {
            if (frame.type == MP_FRAME_EOF)
                p->input_eof = true;
            mp_pin_in_write(p->input_writer->pins[0], frame);
        }
    }
    // A small reserve first, so the first pair does not miss its slot; a
    // short stream still drains through EOF.
    if (!p->primed && (mp_async_queue_get_frames(p->output) >= 4 || mp_async_queue_is_full(p->output) || p->input_eof))
        p->primed = true;
    if (p->primed && mp_pin_in_needs_data(f->ppins[1])) {
        struct mp_frame frame = mp_pin_out_read(p->output_reader->pins[0]);
        if (frame.type != MP_FRAME_NONE)
            mp_pin_in_write(f->ppins[1], frame);
    }
}

static void async_reset(struct mp_filter *f)
{
    struct async_priv *p = f->priv;
    mp_async_queue_reset(p->input);
    mp_async_queue_reset(p->output);
    if (p->thread_valid)
        mp_dispatch_lock(p->dispatch);
    mp_filter_reset(p->root);
    p->primed = p->input_eof = false;
    mp_mutex_lock(&p->metadata_lock);
    talloc_free(p->metadata);
    p->metadata = NULL;
    mp_mutex_unlock(&p->metadata_lock);
    mp_dispatch_interrupt(p->dispatch);
    if (p->thread_valid)
        mp_dispatch_unlock(p->dispatch);
    mp_async_queue_resume_reading(p->input);
    mp_async_queue_resume_reading(p->output);
}

static bool async_command(struct mp_filter *f, struct mp_filter_command *cmd)
{
    struct async_priv *p = f->priv;
    if (cmd->type != MP_FILTER_COMMAND_GET_META)
        return false;
    mp_mutex_lock(&p->metadata_lock);
    struct mp_tags *copy = p->metadata ? mp_tags_dup(NULL, p->metadata) : talloc_zero(NULL, struct mp_tags);
    mp_mutex_unlock(&p->metadata_lock);
    mp_tags_set_str(copy, "queuedOutput", mp_tprintf(32, "%d", mp_async_queue_get_frames(p->output)));
    *(struct mp_tags **)cmd->res = copy;
    return true;
}

static void async_destroy(struct mp_filter *f)
{
    struct async_priv *p = f->priv;
    if (p->thread_valid) {
        mp_dispatch_lock(p->dispatch);
        atomic_store(&p->terminate, true);
        mp_dispatch_interrupt(p->dispatch);
        mp_dispatch_unlock(p->dispatch);
        mp_thread_join(p->thread);
    }
    // Detach both sides before freeing the queues; no wakeup outlives f.
    mp_filter_free_children(f);
    talloc_free(p->root);
    talloc_free(p->input);
    talloc_free(p->output);
    talloc_free(p->metadata);
    mp_mutex_destroy(&p->metadata_lock);
}

static const struct mp_filter_info async_info = {
    .name = "tigerest-vtfi",
    .priv_size = sizeof(struct async_priv),
    .process = async_process,
    .reset = async_reset,
    .destroy = async_destroy,
    .command = async_command,
};

static struct mp_filter *vtfi_create(struct mp_filter *parent, void *options)
{
    struct vtfi_opts opts = options ? *(struct vtfi_opts *)options : vtfi_opts_defaults;
    talloc_free(options);
    struct mp_filter *f = mp_filter_create(parent, &async_info);
    if (!f)
        return NULL;
    struct async_priv *p = f->priv;
    mp_mutex_init(&p->metadata_lock);
    mp_filter_add_pin(f, MP_PIN_IN, "in");
    mp_filter_add_pin(f, MP_PIN_OUT, "out");
    p->input = mp_async_queue_create();
    p->output = mp_async_queue_create();
    // Frames here are references to decoder and pool buffers, not copies.
    // Bounded queues keep latency and the decoder's buffer use small.
    mp_async_queue_set_config(p->input, (struct mp_async_queue_config){.max_samples = 2, .max_bytes = 1 << 30});
    mp_async_queue_set_config(p->output, (struct mp_async_queue_config){.max_samples = 12, .max_bytes = 1 << 30});
    p->dispatch = mp_dispatch_create(p);
    p->root = mp_filter_create_root(f->global);
    mp_filter_graph_set_wakeup_cb(p->root, wakeup_worker, p);
    mp_filter_graph_set_max_run_time(p->root, .05);
    mp_dispatch_set_onlock_fn(p->dispatch, interrupt_worker, p);
    p->core = core_create(p->root, &opts);
    if (!p->core) {
        talloc_free(f);
        return NULL;
    }
    p->input_writer = mp_async_queue_create_filter(f, MP_PIN_IN, p->input);
    struct mp_filter *input_reader = mp_async_queue_create_filter(p->root, MP_PIN_OUT, p->input);
    mp_pin_connect(p->core->pins[0], input_reader->pins[0]);
    struct mp_filter *output_writer = mp_async_queue_create_filter(p->root, MP_PIN_IN, p->output);
    p->output_reader = mp_async_queue_create_filter(f, MP_PIN_OUT, p->output);
    mp_pin_connect(output_writer->pins[0], p->core->pins[1]);
    mp_async_queue_set_notifier(output_writer, f);
    if (mp_thread_create(&p->thread, worker, p)) {
        talloc_free(f);
        return NULL;
    }
    p->thread_valid = true;
    async_reset(f);
    return f;
}

const struct mp_user_filter_entry vf_tigerest_vtfi = {
    .desc = {
        .name = "tigerest-vtfi",
        .description = "Apple VideoToolbox frame interpolation",
        .priv_size = sizeof(OPT_BASE_STRUCT),
        .priv_defaults = &vtfi_opts_defaults,
        .options = vtfi_opts_list,
    },
    .create = vtfi_create,
};
