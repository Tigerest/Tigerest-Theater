"""Check the real EOF patch against the pinned Windows mpv source."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BUILDER = ROOT / "dev/windows/rife/build_mpv.py"


class MpvBuildPreparationTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get('RIFE_TEST_MPV_SOURCE'), 'requires pinned source checkout')
    def test_queue_pointer_patch_preserves_config_and_locked_recomputation(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            relatives = ['filters/f_async_queue.c', 'filters/f_async_queue.h',
                         'filters/f_decoder_wrapper.c', 'audio/out/buffer.c']
            for relative in relatives:
                target = base / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes((Path(os.environ['RIFE_TEST_MPV_SOURCE']) / relative).read_bytes())
            patch = ROOT / 'dev/windows/rife/mpv-win64-queue-pointer.patch'
            if patch.exists():
                applied = subprocess.run(['git', '-C', str(base), 'apply', str(patch)], capture_output=True)
                self.assertEqual(applied.returncode, 0, applied.stderr.decode('utf-8', errors='replace'))
            header = (base / relatives[1]).read_text(encoding='utf-8')
            source = (base / relatives[0]).read_text(encoding='utf-8')
            unit_enum = re.search(r'enum mp_async_queue_sample_unit \{.*?\n\};', header, re.S).group()
            config = re.search(r'struct mp_async_queue_config \{.*?\n\};', header, re.S).group()
            declaration = re.search(r'void mp_async_queue_set_config\(.*?;', header, re.S).group()
            function = re.search(r'void mp_async_queue_set_config\(.*?\n\}', source, re.S).group()
            unit = base / 'queue.c'
            unit.write_text('''#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <string.h>
''' + unit_enum + '\n' + config + '''
struct async_queue { struct mp_async_queue_config cfg; int lock; int recomputations; };
struct mp_async_queue { struct async_queue *q; };
static void mp_mutex_lock(int *lock) { assert(!*lock); *lock=1; }
static void mp_mutex_unlock(int *lock) { assert(*lock); *lock=0; }
static void recompute_sizes(struct async_queue *q) { assert(q->lock); q->recomputations++; }
#define mp_assert assert
#define MPMAX(a,b) ((a)>(b)?(a):(b))
#define MPCLAMP(a,min,max) (((a)<(min))?(min):(((a)>(max))?(max):(a)))
''' + declaration + '\n' + function + '''
int main(void) {
    struct async_queue q={0}; struct mp_async_queue queue={&q};
    struct mp_async_queue_config input={0}, before=input;
    mp_async_queue_set_config(&queue,&input);
    assert(!memcmp(&input,&before,sizeof(input)));
    assert(q.cfg.max_bytes==1 && q.cfg.max_samples==1 && q.cfg.max_duration==0);
    assert(q.cfg.sample_unit==AQUEUE_UNIT_FRAME && !q.lock && !q.recomputations);
    input.max_bytes=65536; input.max_samples=48000; input.max_duration=0.5;
    input.sample_unit=AQUEUE_UNIT_SAMPLES; before=input;
    mp_async_queue_set_config(&queue,&input);
    assert(!memcmp(&input,&before,sizeof(input)) && !q.lock && q.recomputations==1);
    assert(q.cfg.max_bytes==65536 && q.cfg.max_samples==48000 && q.cfg.max_duration==0.5);
    input.max_bytes=-5; input.max_samples=-10; before=input;
    mp_async_queue_set_config(&queue,&input);
    assert(!memcmp(&input,&before,sizeof(input)) && !q.lock && q.recomputations==1);
    assert(q.cfg.max_bytes==1 && q.cfg.max_samples==1 && q.cfg.max_duration==0.5);
    input.max_bytes=INT64_MAX; input.max_samples=INT64_MAX;
    input.sample_unit=AQUEUE_UNIT_FRAME; before=input;
    mp_async_queue_set_config(&queue,&input);
    assert(!memcmp(&input,&before,sizeof(input)) && !q.lock && q.recomputations==2);
    assert(q.cfg.max_bytes==INT64_MAX && q.cfg.max_samples==INT64_MAX);
    return 0;
}
''', encoding='utf-8')
            executable = base / ('queue.exe' if os.name == 'nt' else 'queue')
            compiler = os.environ.get('RIFE_TEST_C_COMPILER', 'cl' if os.name == 'nt' else 'cc')
            flags = ['/nologo', '/TC', '/Fe:' + str(executable), '/Fo:' + str(base / 'queue.obj')] if os.name == 'nt' else ['-std=c11', '-O2', '-o', str(executable)]
            compiled = subprocess.run([compiler, *flags, str(unit)], capture_output=True)
            self.assertEqual(compiled.returncode, 0, (compiled.stdout+compiled.stderr).decode('utf-8', errors='replace'))
            executed = subprocess.run([str(executable)], capture_output=True)
            self.assertEqual(executed.returncode, 0, executed.stderr)

    @unittest.skipUnless(os.environ.get('RIFE_TEST_MPV_SOURCE'), 'requires pinned source checkout')
    def test_hwdec_pointer_patch_preserves_input_and_direct_copy_registration(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            relative = Path('video/decode/vd_lavc.c')
            target = base / relative
            target.parent.mkdir(parents=True)
            target.write_bytes((Path(os.environ['RIFE_TEST_MPV_SOURCE']) / relative).read_bytes())
            applied = subprocess.run(['git', '-C', str(base), 'apply',
                str(ROOT / 'dev/windows/rife/mpv-win64-hwdec-pointer.patch')], capture_output=True)
            self.assertEqual(applied.returncode, 0, applied.stderr.decode('utf-8', errors='replace'))
            source = target.read_text(encoding='utf-8')
            definition = re.search(r'struct hwdec_info \{.*?\n\};', source, re.S).group()
            flags = re.search(r'enum \{\n    HWDEC_FLAG_AUTO.*?\n\};', source, re.S).group()
            autoprobe = re.search(r'struct autoprobe_info \{.*?\n\};', source, re.S).group()
            entries = re.search(r'const struct autoprobe_info hwdec_autoprobe_info\[\] = \{.*?\n\};', source, re.S).group()
            function = re.search(r'static void add_hwdec_item\(.*?\n\}', source, re.S).group()
            unit = base / 'hwdec.c'
            unit.write_text('''#include <assert.h>
#include <limits.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdio.h>
#include <stdarg.h>
#include <string.h>
typedef struct AVCodec { const char *name; } AVCodec;
enum AVHWDeviceType { AV_HWDEVICE_TYPE_NONE, AV_HWDEVICE_TYPE_CUDA };
enum AVPixelFormat { AV_PIX_FMT_NONE, AV_PIX_FMT_YUV420P };
static void mp_snprintf_cat(char *out, size_t size, const char *format, ...) {
    size_t length=strlen(out); va_list args; va_start(args,format);
    vsnprintf(out+length,size-length,format,args); va_end(args);
}
#define MP_TARRAY_APPEND(ctx, array, count, value) ((array)[(count)++]=(value))
''' + definition + '\n' + flags + '\n' + autoprobe + '\n' + entries + '\n' + function + '''
int main(void) {
    const AVCodec codec={"h264"};
    struct hwdec_info storage[2], *items=storage, input={0}; int count=0;
    input.codec=&codec; input.lavc_device=AV_HWDEVICE_TYPE_CUDA;
    input.pix_fmt=AV_PIX_FMT_YUV420P; input.use_hw_frames=true;
    strcpy(input.method_name,"nvdec"); struct hwdec_info before=input;
    add_hwdec_item(&items,&count,&input);
    assert(!memcmp(&before,&input,sizeof(input)));
    input.copying=true; before=input;
    add_hwdec_item(&items,&count,&input);
    assert(!memcmp(&before,&input,sizeof(input)));
    assert(count==2 && !strcmp(items[0].name,"h264-nvdec"));
    assert(!strcmp(items[1].name,"h264-nvdec-copy"));
    assert(items[0].rank==0 && items[1].rank==1);
    assert(items[0].flags==(HWDEC_FLAG_AUTO|HWDEC_FLAG_WHITELIST));
    assert(items[1].flags==items[0].flags && items[1].auto_pos>items[0].auto_pos);
    assert(items[0].codec==&codec && items[1].codec==&codec);
    assert(items[0].use_hw_frames && items[1].use_hw_frames);
    assert(items[0].pix_fmt==AV_PIX_FMT_YUV420P && items[1].pix_fmt==AV_PIX_FMT_YUV420P);
    return 0;
}
''', encoding='utf-8')
            executable = base / ('hwdec.exe' if os.name == 'nt' else 'hwdec')
            compiler = os.environ.get('RIFE_TEST_C_COMPILER', 'cl' if os.name == 'nt' else 'cc')
            flags = ['/nologo', '/TC', '/Fe:' + str(executable), '/Fo:' + str(base / 'hwdec.obj')] if os.name == 'nt' else ['-std=c11', '-O2', '-o', str(executable)]
            compiled = subprocess.run([compiler, *flags, str(unit)], capture_output=True)
            self.assertEqual(compiled.returncode, 0, (compiled.stdout+compiled.stderr).decode('utf-8',errors='replace'))
            executed = subprocess.run([str(executable)], capture_output=True)
            self.assertEqual(executed.returncode, 0, executed.stderr)

    def compile_vo_function(self, name, patterns, harness):
        # Compile functions of the patched vo.c against a stub harness.
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            relative = Path('video/out/vo.c')
            target = base / relative
            target.parent.mkdir(parents=True)
            target.write_bytes((Path(os.environ['RIFE_TEST_MPV_SOURCE']) / relative).read_bytes())
            applied = subprocess.run(['git', '-C', str(base), 'apply', '--include=video/out/vo.c',
                str(ROOT / 'dev/windows/rife/mpv-win32-precise-flip.patch')], capture_output=True)
            self.assertEqual(applied.returncode, 0, applied.stderr.decode('utf-8', errors='replace'))
            source = target.read_text(encoding='utf-8')
            functions = '\n'.join(re.search(pattern, source, re.S).group() for pattern in patterns)
            prelude, main = harness
            unit = base / (name + '.c')
            unit.write_text(prelude + functions + '\n' + main, encoding='utf-8')
            executable = base / (name + '.exe' if os.name == 'nt' else name)
            compiler = os.environ.get('RIFE_TEST_C_COMPILER', 'cl' if os.name == 'nt' else 'cc')
            flags = ['/nologo', '/TC', '/Fe:' + str(executable), '/Fo:' + str(base / (name + '.obj'))] if os.name == 'nt' else ['-std=c11', '-O2', '-o', str(executable)]
            libraries = [] if os.name == 'nt' else ['-lm']
            compiled = subprocess.run([compiler, *flags, str(unit), *libraries], capture_output=True)
            self.assertEqual(compiled.returncode, 0, (compiled.stdout + compiled.stderr).decode('utf-8', errors='replace'))
            executed = subprocess.run([str(executable)], capture_output=True)
            self.assertEqual(executed.returncode, 0, executed.stderr)

    @unittest.skipUnless(os.environ.get('RIFE_TEST_MPV_SOURCE'), 'requires pinned source checkout')
    def test_precise_flip_patch_never_flips_before_target(self):
        # Win32-like condition waits: whole milliseconds, truncated, and woken
        # up to 0.9 ms late. The patched wait must still end exactly at target.
        self.compile_vo_function('flip', [r'static void wait_until\(struct vo \*vo, int64_t target\)\n\{.*?\n\}'], ('''#include <assert.h>
#include <stdint.h>
#define HAVE_WIN32_THREADS 1
#define VO_EVENT_LIVE_RESIZING 32
#define MP_TIME_MS_TO_NS(ms) ((ms) * INT64_C(1000000))
struct vo_internal { int lock, wakeup, queued_events; };
struct vo { struct vo_internal *in; };
static int64_t now, slop;
static int sleeps;
static int64_t mp_time_ns(void) { return now += 1000; }
static void mp_mutex_lock(int *lock) { assert(!*lock); *lock = 1; }
static void mp_mutex_unlock(int *lock) { assert(*lock); *lock = 0; }
static int mp_cond_timedwait(int *cond, int *lock, int64_t timeout) {
    assert(*lock);
    int64_t ms = (timeout < 0 ? 0 : timeout) / MP_TIME_MS_TO_NS(1);
    if (ms) { now += MP_TIME_MS_TO_NS(ms) + slop; sleeps++; }
    return 138;
}
static int mp_cond_timedwait_until(int *cond, int *lock, int64_t until) {
    return mp_cond_timedwait(cond, lock, until - mp_time_ns());
}
''', '''int main(void) {
    struct vo_internal in = {0}; struct vo vo = {&in};
    for (slop = 0; slop <= 900000; slop += 300000) {
        for (int64_t step = 0; step < 40; step++) {
            int64_t start = now, goal = now + step * 370000;
            sleeps = 0;
            wait_until(&vo, goal);
            assert(now >= goal && now - goal <= 2000);
            assert(!in.lock);
            if (goal - start > MP_TIME_MS_TO_NS(2)) assert(sleeps >= 1);
        }
    }
    in.queued_events = VO_EVENT_LIVE_RESIZING;
    int64_t goal = now + MP_TIME_MS_TO_NS(5);
    wait_until(&vo, goal);
    assert(now < goal && !in.lock);
    return 0;
}
'''))

    FLIP_PRELUDE = '''#include <assert.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#define MP_TIME_S_TO_NS(s) ((s) * INT64_C(1000000000))
#define MP_TIME_US_TO_NS(us) ((us) * INT64_C(1000))
#define MPMAX(a, b) ((a) > (b) ? (a) : (b))
#define MPCLAMP(a, min, max) (((a) < (min)) ? (min) : (((a) > (max)) ? (max) : (a)))
#define MP_VERBOSE(vo, ...) ((void)(vo), verbose++)
static int verbose;
struct vo_internal {
    double vsync_interval; int64_t last_vsync_time; bool paused, composed;
    struct { bool place; int64_t id[8], vsync[8]; bool place_of[8];
             int counts[4], scored; double share[2]; int age[2]; } flips;
    struct { int frames, no_vsync, no_match; double refresh; } grid;
};
struct vo { struct vo_internal *in; };
struct vo_vsync_info { int64_t last_queue_display_time, vsync_duration, skipped_vsyncs, last_vsync_time; bool composed;
                       int64_t submit_id, shown_id, shown_vsync; };
'''

    @unittest.skipUnless(os.environ.get('RIFE_TEST_MPV_SOURCE'), 'requires pinned source checkout')
    def test_flip_alignment_keeps_one_vsync_per_frame(self):
        # 59.94 fps on 240 Hz must hold every frame for 4 vsyncs, with one
        # isolated 5 about every 4 s, and flip just before the vsync before
        # the one it is shown on, or half a vsync before the one DWM takes it.
        # Without a fixed refresh grid (VRR) the reported vsync is not used.
        self.compile_vo_function('align', [r'static int64_t align_flip_to_vsync\(.*?\n\}',
                                           r'static int64_t vsync_grid_anchor\(.*?\n\}',
                                           r'static void count_missing_grid\(.*?\n\}'], (self.FLIP_PRELUDE, '''static int64_t shown(struct vo_internal *in, int64_t flip) {
    // A present needs longer than 50 us to reach the screen: a flip just
    // before a vsync is shown on the one after it. DWM takes presents until
    // shortly before a vsync (and shows them one vsync later).
    double v = in->vsync_interval, n = (flip - in->last_vsync_time) / v;
    int64_t vsync = in->last_vsync_time + (int64_t)llround((ceil(n) + !in->composed) * v);
    if (in->composed)
        assert(vsync - flip >= 0.45 * v && vsync - flip <= 0.55 * v);
    else
        assert(vsync - v - flip >= 40000 && vsync - v - flip <= 60000);
    return vsync;
}
static void play(double fps, int seconds, int64_t lag, bool composed, int holds[8]) {
    struct vo_internal in = {1e9 / 240, MP_TIME_S_TO_NS(5), false, composed};
    double v = in.vsync_interval;
    int64_t duration = (int64_t)(1e9 / fps), previous = 0;
    for (int64_t n = 0; n < (int64_t)(fps * seconds); n++) {
        int64_t target = MP_TIME_S_TO_NS(5) + 1234567 + (int64_t)(n * 1e9 / fps), aligned;
        int64_t flip = align_flip_to_vsync(&in, target, duration, &aligned);
        int64_t vsync = shown(&in, flip);
        assert(vsync >= target && vsync - v < target);
        assert(composed ? llabs(aligned - vsync) <= 1 : !aligned);
        if (previous) holds[llround((vsync - previous) / v)]++;
        previous = vsync;
        // The VO reports a recent vsync, which may lag the one just used.
        in.last_vsync_time = vsync - (int64_t)llround(lag * v);
    }
}
int main(void) {
    for (int composed = 0; composed < 2; composed++) {
        for (int lag = 0; lag < 3; lag++) {
            int holds[8] = {0};
            play(60000 / 1001.0, 60, lag, composed, holds);
            assert(!holds[0] && !holds[1] && !holds[2] && !holds[3] && !holds[6] && !holds[7]);
            assert(holds[5] >= 13 && holds[5] <= 15 && holds[4] + holds[5] == 3595);
        }
    }
    int holds[8] = {0};
    play(160, 10, 1, false, holds);
    assert(!holds[0] && abs(holds[1] - holds[2]) == 1 && holds[1] + holds[2] == 1599);
    struct vo_internal in = {1e9 / 240, MP_TIME_S_TO_NS(5), false, true};
    int64_t target = MP_TIME_S_TO_NS(5) + 1000000, frame = 16683333, aligned;
    assert(align_flip_to_vsync(&in, target, frame, &aligned) != target && aligned);
    assert(align_flip_to_vsync(&in, target, 6000000, &aligned) == target && !aligned);
    assert(align_flip_to_vsync(&in, target, -1, &aligned) == target && !aligned);
    assert(align_flip_to_vsync(&in, MP_TIME_S_TO_NS(7), frame, &aligned) == MP_TIME_S_TO_NS(7) && !aligned);
    in.paused = true;
    assert(align_flip_to_vsync(&in, target, frame, &aligned) == target && !aligned);
    in.paused = false; in.last_vsync_time = 0;
    assert(align_flip_to_vsync(&in, target, frame, &aligned) == target && !aligned);
    in.last_vsync_time = MP_TIME_S_TO_NS(5); in.vsync_interval = 1;
    assert(align_flip_to_vsync(&in, target, frame, &aligned) == target && !aligned);
    // Fixed 240 Hz keeps the reported vsync; VRR at the frame rate, an
    // unknown period or another display's rate drops it.
    in.vsync_interval = 1e9 / 240;
    struct vo_vsync_info info = {-1, 4166667, -1, MP_TIME_S_TO_NS(6)};
    assert(vsync_grid_anchor(&in, &info) == MP_TIME_S_TO_NS(6));
    info.vsync_duration = 4166000;
    assert(vsync_grid_anchor(&in, &info) == MP_TIME_S_TO_NS(6));
    info.vsync_duration = 16683333;
    assert(vsync_grid_anchor(&in, &info) == 0);
    info.vsync_duration = 0;
    assert(vsync_grid_anchor(&in, &info) == 0);
    info.vsync_duration = -1;
    assert(vsync_grid_anchor(&in, &info) == 0);
    info.vsync_duration = 4166667; in.vsync_interval = 1e9 / 60;
    assert(vsync_grid_anchor(&in, &info) == 0);
    // Composed frames without a grid are counted by reason, and the counts
    // start over after 600 composed frames.
    struct vo vo = {&in};
    in.vsync_interval = 1e9 / 240;
    const struct { int64_t duration, vsync; bool composed; int frames; } script[] = {
        {4166667, 0, true, 100}, {16683333, MP_TIME_S_TO_NS(6), true, 200},
        {16683333, MP_TIME_S_TO_NS(6), false, 50}, {4166667, MP_TIME_S_TO_NS(6), true, 299}};
    for (int s = 0; s < 4; s++) {
        for (int i = 0; i < script[s].frames; i++) {
            struct vo_vsync_info frame = {-1, script[s].duration, -1, script[s].vsync, script[s].composed};
            in.last_vsync_time = vsync_grid_anchor(&in, &frame);
            count_missing_grid(&vo, &frame);
        }
    }
    assert(in.grid.frames == 599 && in.grid.no_vsync == 100 && in.grid.no_match == 200);
    assert(fabs(in.grid.refresh - 16.683333) < 1e-6 && !verbose);
    info.composed = true;
    count_missing_grid(&vo, &info);
    assert(!in.grid.frames && !in.grid.no_vsync && !in.grid.no_match && verbose == 1);
    // Up to 1% (missing at the start or after a disjoint) is not logged.
    for (int i = 0; i < 600; i++) {
        struct vo_vsync_info frame = {-1, 4166667, -1, i < 6 ? 0 : MP_TIME_S_TO_NS(6), true};
        in.last_vsync_time = vsync_grid_anchor(&in, &frame);
        count_missing_grid(&vo, &frame);
    }
    assert(!in.grid.frames && verbose == 1);
    return 0;
}
'''))

    @unittest.skipUnless(os.environ.get('RIFE_TEST_MPV_SOURCE'), 'requires pinned source checkout')
    def test_composed_flips_move_away_from_the_dwm_deadline(self):
        # DWM takes a present at a deadline before each vsync and shows it on
        # that vsync or the next. Composed flips must end up where 59.94 fps on
        # 240 Hz keeps 4-vsync holds (isolated 5s), wherever the deadline is:
        # stay put while it is far away, leave a place it sits on, return to
        # a place whose bad score is old, and not move every window when both
        # places are poor.
        self.compile_vo_function('flips', [r'static int64_t align_flip_to_vsync\(.*?\n\}',
                                           r'static void score_composed_flips\(.*?\n\}'], (self.FLIP_PRELUDE, '''
static uint32_t seed = 1;
static double rnd(void) { seed = seed * 1664525u + 1013904223u; return (seed >> 8) / 16777216.0; }
// The deadline is lo..hi ns before a vsync, or lo2..hi2 for half of them.
struct dwm { double lo, hi, lo2, hi2; int later; };
static int64_t shown_on(const struct dwm *d, double v, int64_t flip) {
    for (int64_t k = (int64_t)ceil(flip / v);; k++) {
        bool second = d->hi2 > 0 && rnd() < 0.5;
        double deadline = second ? d->lo2 + (d->hi2 - d->lo2) * rnd() : d->lo + (d->hi - d->lo) * rnd();
        int64_t vsync = (int64_t)llround(k * v);
        if (vsync - deadline >= flip)
            return vsync + (int64_t)llround(d->later * v);
    }
}
static struct vo_internal in = {1e9 / 240, MP_TIME_S_TO_NS(5), false, true};
static struct vo vo = {&in};
static int64_t shown[64], frames, moves, windows;
static void play(const struct dwm *d, double seconds, double settle, int holds[8]) {
    double v = in.vsync_interval, fps = 60000 / 1001.0;
    for (int64_t n = 0; n < (int64_t)(fps * seconds); n++) {
        int64_t target = MP_TIME_S_TO_NS(5) + 1234567 + (int64_t)(frames * 1e9 / fps), aligned, id = ++frames;
        int64_t flip = align_flip_to_vsync(&in, target, (int64_t)(1e9 / fps), &aligned);
        assert(aligned >= target && aligned - v < target);
        shown[id & 63] = shown_on(d, v, flip);
        if (holds && n >= fps * settle)
            holds[MPCLAMP(llround((shown[id & 63] - shown[(id - 1) & 63]) / v), 0, 7)]++;
        // The VO reports the previous frame as the last one shown, and its
        // vsync as a recent one.
        struct vo_vsync_info info = {.composed = true, .submit_id = id, .shown_id = id - 1,
                                     .shown_vsync = shown[(id - 1) & 63]};
        in.last_vsync_time = id > 1 ? info.shown_vsync : MP_TIME_S_TO_NS(5);
        bool place = in.flips.place;
        int scored = in.flips.scored, logged = verbose;
        score_composed_flips(&vo, &info, aligned);
        moves += in.flips.place != place;
        windows += in.flips.scored < scored;
        assert(verbose - logged == (in.flips.place != place));
    }
}
static void regular(const int holds[8], int seconds) {
    // 4-vsync holds with an isolated 5 about every 4.2 s.
    assert(!holds[0] && !holds[1] && !holds[2] && !holds[3] && !holds[6] && !holds[7]);
    assert(holds[5] >= seconds / 4.17 - 1.5 && holds[5] <= seconds / 4.17 + 1.5);
}
int main(void) {
    const struct dwm early = {300000, 500000, 0, 0, 1}, wide = {1300000, 3000000, 0, 0, 0},
                     late = {0, 70000, 0, 0, 1}, both = {1900000, 2300000, 20000, 80000, 0};
    // Deadline 0.3-0.5 ms before the vsync: both places are fine, from either.
    for (int start = 0; start < 2; start++) {
        int holds[8] = {0};
        memset(&in.flips, 0, sizeof(in.flips)); in.flips.place = start; moves = 0;
        play(&early, 60, 0.1, holds);
        regular(holds, 60);
        assert(!moves && in.flips.place == start);
    }
    // 1.3-3 ms: half way between vsyncs sits on it, and the flips move once.
    int holds[8] = {0};
    memset(&in.flips, 0, sizeof(in.flips)); moves = windows = 0;
    play(&wide, 10, 5, holds);
    regular(holds, 5);
    assert(moves == 1 && in.flips.place == 1);
    // Then 0-0.07 ms: just before a vsync is poor but scores better than half
    // way did 10-28 s ago, until that score is forgotten.
    play(&late, 20, 0, NULL);
    assert(moves == 1 && in.flips.place == 1);
    memset(holds, 0, sizeof(holds));
    play(&late, 40, 20, holds);
    regular(holds, 20);
    assert(moves == 2 && in.flips.place == 0);
    // Both places poor: not a move every window.
    memset(&in.flips, 0, sizeof(in.flips)); moves = windows = 0;
    play(&both, 120, 0, NULL);
    assert(windows >= 55 && moves >= 2 && moves <= windows * 3 / 4);
    // Each shown present is scored once, and a report without one not at all:
    // present 1 is shown on time (and reported twice), 3 a vsync late, 2 never.
    memset(&in.flips, 0, sizeof(in.flips));
    const int64_t reports[5][2] = {{0, 0}, {1, 0}, {1, 0}, {0, 0}, {3, 1}};
    for (int64_t id = 1; id <= 5; id++) {
        int64_t aligned = MP_TIME_S_TO_NS(6) + id * 16683333, shown = reports[id - 1][0];
        struct vo_vsync_info info = {.composed = true, .submit_id = id, .shown_id = shown,
            .shown_vsync = shown ? MP_TIME_S_TO_NS(6) + shown * 16683333 + reports[id - 1][1] * 4166667 : 0};
        score_composed_flips(&vo, &info, aligned);
    }
    assert(in.flips.scored == 2 && in.flips.counts[1] == 1 && in.flips.counts[2] == 1);
    return 0;
}
'''))

    @unittest.skipUnless(os.environ.get("RIFE_TEST_MPV_SOURCE"), "requires pinned source checkout")
    def test_private_core_function_compiles_against_pinned_api(self):
        # Applying a patch does not validate its API names. Compile the actual
        # resulting function using our unmodified, pinned VapourSynth headers.
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            relative = Path("video/filter/vf_vapoursynth.c")
            target = base / relative
            target.parent.mkdir(parents=True)
            target.write_bytes((Path(os.environ["RIFE_TEST_MPV_SOURCE"]) / relative).read_bytes())
            subprocess.run(["git", "-C", str(base), "apply", "--include=video/filter/vf_vapoursynth.c", str(ROOT / "dev/macos/rife/mpv-eof-aware.patch"),
                            str(ROOT / "dev/windows/rife/mpv-private-vs-core.patch")], check=True,
                           capture_output=True)
            match = re.search(r"static int drv_vss_load_core\(struct priv \*p\)\n\{.*?\n\}",
                              target.read_text(encoding="utf-8"), re.S)
            self.assertIsNotNone(match)
            unit = base / "private_core.c"
            unit.write_text('#include <stddef.h>\n#include "VSScript4.h"\n'
                'struct options { int eof_aware; };\n'
                'struct priv { const VSSCRIPTAPI *vs_script_api; const VSAPI *vsapi; '
                'VSScript *vs_script; VSCore *vscore; struct options *opts; };\n'
                + match.group() + '\n', encoding="utf-8")
            compiler = os.environ.get("RIFE_TEST_C_COMPILER", "cl" if os.name == "nt" else "cc")
            flags = ["/nologo", "/Zs", "/TC", "/I" + str(ROOT / "dev/windows/rife/include")] if os.name == "nt" else [
                "-fsyntax-only", "-D_WIN32", "-D__stdcall=", "-D__declspec(x)=", "-I", str(ROOT / "dev/windows/rife/include")]
            result = subprocess.run([compiler, *flags, str(unit)], capture_output=True)
            self.assertEqual(result.returncode, 0, (result.stdout + result.stderr).decode("utf-8", errors="replace"))

    def run_check(self, source):
        with tempfile.TemporaryDirectory() as temp:
            report = Path(temp) / "report.json"
            result = subprocess.run([sys.executable, str(BUILDER), "--check-source", str(source),
                                     "--report", str(report)], capture_output=True, text=True, timeout=30)
            self.assertTrue(report.exists(), result.stderr)
            return result.returncode, json.loads(report.read_text(encoding="utf-8"))

    def test_wrong_source_is_rejected_before_build(self):
        with tempfile.TemporaryDirectory() as temp:
            source = Path(temp)
            subprocess.run(["git", "init", "-q", str(source)], check=True)
            (source / "fixture").write_text("incorrect source", encoding="utf-8")
            subprocess.run(["git", "-C", str(source), "add", "fixture"], check=True)
            subprocess.run(["git", "-C", str(source), "-c", "user.name=Test",
                            "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"], check=True)
            code, report = self.run_check(source)
            self.assertNotEqual(code, 0)
            self.assertEqual(report["errorCode"], "source-sha")

    @unittest.skipUnless(os.environ.get("RIFE_TEST_MPV_SOURCE"), "requires pinned source checkout")
    def test_complete_eof_patch_applies_without_modifying_original_source(self):
        source = Path(os.environ["RIFE_TEST_MPV_SOURCE"])
        code, report = self.run_check(source)
        self.assertEqual(code, 0, report)
        self.assertEqual(report["sourceSha"], "dd5d17d3285a095a0f712fa9d116e22a076492de")
        self.assertTrue(report["eofPatchApplicable"])
        self.assertTrue(report['privateCorePatchApplicable'])
        self.assertTrue(report['flipPatchApplicable'])
        self.assertEqual(subprocess.run(["git", "-C", str(source), "diff", "--quiet"]).returncode, 0)


if __name__ == "__main__":
    unittest.main()
