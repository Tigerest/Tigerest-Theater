"""Windows mpv bridge for NVIDIA Video Frame Generation (VFG).

mpv loads this file with vf=vapoursynth and hands over `video_in` and the
`user_data` JSON string, like interpolate_trt.vpy. Keys:

  runtime_path      the RIFE extension's runtime root (private Python and VapourSynth)
  vfg_runtime_path  directory with NVVideoEffects.dll, NVCVImage.dll and the VFG feature DLL
  vfg_plugin_path   tigerest-vfg-vs.dll
  mode              0 low, 1 medium, 2 high (default 2)
  fps_num, fps_den  source frame rate, as in the RIFE script (video_in carries none)
  out_fps_num, out_fps_den   output frame rate; or instead
  factor            output rate as a multiple of the source rate (2, 2.5, ...)
  scene_threshold   mean absolute RGB difference (0..1) from which two source frames
                    count as a shot change even when the SDK does not report one;
                    default 0.25, the RIFE script's rule; 0 leaves it to the SDK
  threads           VapourSynth worker threads (default 4)
  cache_mb          VapourSynth frame cache budget in MiB (default 1024)
  streaming         true (default): the input is mpv's eof-aware stream
  monitor           true attaches the client's Monitor filter as the RIFE script
                    does; it then also needs plugin_path and session
  debug_log         a file path: appends why the script repeats instead of
                    generating, and a counter line every 120 output frames
  stats_path        a file path: rewritten twice a second with what the last
                    half second produced (see LiveStats), for the client's
                    professional mode

Source frames that go missing while playback stalls leave one long duration
behind; that frame is repeated across the hole and generation goes on (see
CfrTiming).

The input is converted to RGB (8-bit for 8-bit input, 10-bit otherwise) with the
matrix, range and chroma placement mpv tagged on each frame, interpolated, and
converted back with the same three values. Frames that coincide with a source
frame, the repeats at a shot change and after the last frame are the untouched
input frames. Input the RIFE path would not interpolate (HDR, incomplete colour
tags, interlaced, variable frame rate) is repeated instead, with the same
reason strings.
"""
import json
import os
from contextlib import ExitStack
from fractions import Fraction
from pathlib import Path
from threading import RLock
import time
import vapoursynth as vs
import weakref


class CfrTiming:
    """Accepts source durations that stay on a constant frame rate (as trt_pipeline.py).

    A stall is not a variable frame rate. While playback stalls (the video
    window is resized, the clock changes, the GPU is busy for a moment) mpv
    discards source frames: the frame before the hole then carries the hole's
    length (249 ms where 41.7 was due, 2026-11-17), and the one after it may
    come without a duration at all. accept() answers GAP for the long frame and
    UNTIMED for one without a duration, and counts on from the next. Frames
    next to each other are one stall; a fifth within 240 source frames, or a
    duration off the rate by less than a frame, ends it for good.
    """

    GAP = 'gap'
    UNTIMED = 'untimed'
    SPAN = 240
    STALLS = 4

    def __init__(self, fps):
        self.lock = RLock()
        self.expected = 1 / fps
        self.next = 0
        self.pending = {}
        self.error = 0.
        self.count = 0
        self.accepted = True
        self.holes = {}

    def accept(self, index, duration):
        """duration is None where mpv gave the frame none."""
        with self.lock:
            if not self.accepted:
                return False
            # Every output frame of a source frame asks, in any order.
            if index in self.holes:
                return self.holes[index]
            if duration is None or abs(float(duration - self.expected)) > 1.1e-3:
                if duration is not None and float(duration) < float(self.expected) * 1.9:
                    self.accepted = False
                    return False
                self.holes = {at: verdict for at, verdict in self.holes.items() if abs(index - at) < self.SPAN}
                self.holes[index] = self.UNTIMED if duration is None else self.GAP
                frames = sorted(self.holes)
                stalls = 1 + sum(1 for before, after in zip(frames, frames[1:]) if after - before > 3)
                if stalls > self.STALLS:
                    self.accepted = False
                    return False
                self.next = max(self.next, index + 1)
                self.pending = {key: value for key, value in self.pending.items() if key >= self.next}
                self.error, self.count = 0., 0
                return self.holes[index]
            if index < self.next:
                return True
            if index > self.next + 120:
                self.next = index
                self.pending.clear()
                self.error, self.count = 0., 0
            self.pending[index] = duration
            # Concurrent callbacks may revisit frames or arrive out of order.
            # Accumulate each contiguous source duration once.
            while self.next in self.pending:
                self.error += float(self.pending.pop(self.next) - self.expected)
                self.next += 1
                self.count += 1
                self.accepted = abs(self.error) <= 1.1e-3 + self.count * 1e-6
                if not self.accepted:
                    return False
                if self.count == 120:
                    self.error, self.count = 0., 0
            return self.accepted


class DebugLog:
    """Diagnostics for a run in the real player; only exists with the debug_log option."""

    WATCHED = ('_Matrix', '_Transfer', '_Primaries', '_ColorRange', '_Range', '_ChromaLocation', '_FieldBased',
               '_TigerestColorKnown', '_TigerestLastFrame', '_TigerestVfgSourceDurationNum',
               '_TigerestVfgSourceDurationDen', '_DurationNum', '_DurationDen')

    def __init__(self, path):
        self.path = path
        self.lock = RLock()
        self.began = self.window = time.monotonic()
        self.frames = 0
        self.counts = {}
        self.spent = 0.
        self.uploads = self.runs = 0
        self.first = True

    def write(self, text):
        try:
            with self.lock, open(self.path, 'a', encoding='utf-8') as sink:
                sink.write(f'{time.strftime("%H:%M:%S")} +{time.monotonic() - self.began:9.3f}s {text}\n')
        except OSError:
            pass

    @staticmethod
    def text(value):
        return value.decode('utf-8', 'replace') if isinstance(value, bytes) else str(value)

    def values(self, props, names=None):
        try:
            return ' '.join(f'{name}={self.text(props[name])[:40]}' for name in (names or sorted(props)) if name in props)
        except Exception as error:  # never let diagnostics stop playback
            return f'(properties unreadable: {error})'

    def source(self, n, index, props):
        if self.first:
            self.first = False
            self.write(f'first source frame seen: n={n} index={index} | {self.values(props)}')

    def decision(self, kind, reason, n, index, phase, props, detail=''):
        self.write(f'{kind}: reason={reason} n={n} index={index} phase={phase} {detail}| {self.values(props, self.WATCHED)}')

    def observe(self, n, f):
        # Runs on every output frame and hands the frame on untouched.
        try:
            props = f.props
            generated = props.get('_TigerestVfgGenerated', 0) == 1
            reason = self.text(props.get('_TigerestVfgReason', ''))
            with self.lock:
                kind = 'generated' if generated else 'repeated:' + (reason or 'source')
                self.counts[kind] = self.counts.get(kind, 0) + 1
                if generated:
                    self.spent += props.get('_TigerestVfgTimeMs', 0.)
                    self.uploads = max(self.uploads, props.get('_TigerestVfgUploads', 0))
                    self.runs = max(self.runs, props.get('_TigerestVfgRuns', 0))
                elif reason in ('cut', 'eof', 'gap', 'untimed'):
                    self.write(f'repeat: reason={reason} n={n} duration={props.get("_DurationNum")}/{props.get("_DurationDen")}')
                self.frames += 1
                if self.frames % 120 == 0:
                    now = time.monotonic()
                    made = self.counts.get('generated', 0)
                    repeats = ', '.join(f'{name} {count}' for name, count in sorted(self.counts.items()) if name != 'generated')
                    self.write(f'counters: output frames {self.frames} (last n={n}), in the last 120: generated {made}, '
                               f'{repeats or "repeated 0"}, shot changes {self.counts.get("repeated:cut", 0)}; '
                               f'since the graph was built: uploads {self.uploads}, effect runs {self.runs}; '
                               f'mean {self.spent / made if made else 0:.2f} ms in the plugin per generated frame; '
                               f'{120 / max(now - self.window, 1e-6):.1f} output fps')
                    self.window = now
                    self.counts = {}
                    self.spent = 0.
        except Exception as error:
            self.write(f'observer failed: {error}')
        return f


class LiveStats:
    """What the graph produced in the last half second, as a small JSON file.

    {t, output_fps, generated_fps, ms, repeats, disabled}: t is time.time()
    when it was written, the two rates are frames a second of wall-clock time,
    ms is the mean time the plugin spent on one generated frame, repeats counts
    the repeated frames by reason, disabled is the reason generation stopped
    for the rest of the graph, or empty.
    """

    INTERVAL = 0.5

    def __init__(self, path, disabled):
        self.path = path
        self.disabled = disabled
        self.lock = RLock()
        self.window = time.monotonic()
        self.frames = self.generated = 0
        self.spent = 0.
        self.repeats = {}

    def observe(self, n, f):
        # Runs on every output frame and hands the frame on untouched.
        try:
            props = f.props
            with self.lock:
                self.frames += 1
                if props.get('_TigerestVfgGenerated', 0) == 1:
                    self.generated += 1
                    self.spent += props.get('_TigerestVfgTimeMs', 0.)
                else:
                    reason = DebugLog.text(props.get('_TigerestVfgReason', '')) or 'source'
                    self.repeats[reason] = self.repeats.get(reason, 0) + 1
                now = time.monotonic()
                span = now - self.window
                if span < self.INTERVAL:
                    return f
                record = {'t': time.time(), 'output_fps': self.frames / span, 'generated_fps': self.generated / span,
                          'ms': self.spent / self.generated if self.generated else 0., 'repeats': self.repeats,
                          'disabled': self.disabled() or ''}
                self.window = now
                self.frames = self.generated = 0
                self.spent = 0.
                self.repeats = {}
                # Replaced in one step: the client never reads half a file.
                with open(self.path + '.new', 'w', encoding='utf-8') as sink:
                    json.dump(record, sink)
                os.replace(self.path + '.new', self.path)
        except Exception:  # never let the counters stop playback
            pass
        return f


def pixel_range(props):
    if '_Range' in props:
        return props['_Range']
    legacy = props.get('_ColorRange', -1)
    return 1 - legacy if legacy in (0, 1) else -1


def build_vfg_filter(source, options):
    core = vs.core
    layout = source.format
    if layout is None or source.width <= 0 or source.height <= 0:
        raise ValueError('VFG requires a constant video format')
    if layout.color_family != vs.YUV or layout.sample_type != vs.INTEGER:
        raise ValueError('VFG requires integer YUV input')
    fps = Fraction(int(options['fps_num']), int(options['fps_den']))
    if fps <= 0:
        raise ValueError('Unsupported source frame rate')
    if 'out_fps_num' in options:
        output_fps = Fraction(int(options['out_fps_num']), int(options.get('out_fps_den', 1)))
    else:
        output_fps = fps * Fraction(str(options['factor']))
    if output_fps < fps:
        raise ValueError('The VFG output rate must not be below the source rate')
    mode = int(options.get('mode', 2))
    if mode not in (0, 1, 2):
        raise ValueError('Unsupported VFG mode')
    scene_threshold = float(options.get('scene_threshold', 0.25))
    if not 0 <= scene_threshold <= 1:
        raise ValueError('Unsupported VFG scene threshold')
    streaming = bool(options.get('streaming', True))
    monitor = bool(options.get('monitor', False))
    log = DebugLog(str(options['debug_log'])) if options.get('debug_log') else None
    live = LiveStats(str(options['stats_path']), lambda: disabled) if options.get('stats_path') else None
    step = fps / output_fps  # source frames per output frame
    step_num, step_den = step.numerator, step.denominator
    rates = dict(fpsnum=output_fps.numerator, fpsden=output_fps.denominator,
                 srcfpsnum=fps.numerator, srcfpsden=fps.denominator)
    timing = CfrTiming(fps)
    graph_lock = RLock()
    disabled = None
    bypasses = {}
    routes = {}

    # Source frames at the output rate. Nothing below converts or uploads a
    # frame until the callbacks ask for a generated one.
    held = core.tigerest_vfg.Sample(source, **rates)
    rgb = core.resize.Bicubic(source, format=vs.RGB24 if layout.bits_per_sample == 8 else vs.RGB30, range=1)
    generated = core.tigerest_vfg.Interpolate(rgb, runtime=str(options['vfg_runtime_path']), mode=mode,
                                              scenecut=scene_threshold, **rates)

    def stamp(clip, synthesized, reason=''):
        values = {'_TigerestVfgReason': reason}
        if monitor:
            values.update(_TigerestRifeSynthesized=synthesized, _TigerestRifeTimingAvailable=0,
                          _TigerestRifeReason=reason)
        return core.std.SetFrameProps(clip, **values)

    def bypass(reason=''):
        with graph_lock:
            if reason not in bypasses:
                # Repeats inside an interpolated stream keep the output cadence.
                # A stream that is not interpolated at all keeps each source
                # frame's own duration, shared by its repeats; so does the
                # frame before a gap, which spans the hole. A frame mpv gave
                # no duration has only the output cadence to go by.
                clip = held if reason in ('', 'cut', 'eof', 'untimed') else core.tigerest_vfg.Sample(source, hold=1, **rates)
                bypasses[reason] = stamp(clip, 0, reason)
            return bypasses[reason]

    def disable(reason, n, index, phase, props):
        nonlocal disabled
        disabled = reason
        if log:
            log.decision('disabled for the rest of this graph', reason, n, index, phase, props,
                         f'expected-duration={float(timing.expected):.6f}s timing-error={timing.error:.6f}s '
                         f'timing-next={timing.next} ')
        return bypass(reason)

    def eligibility(index, props):
        if props.get('_TigerestColorKnown', 1) == 0:
            return 'unknown-color'
        transfer = props.get('_Transfer', -1)
        if transfer in (16, 18):
            return 'hdr'
        if (props.get('_Matrix', -1) not in (1, 5, 6) or pixel_range(props) not in (0, 1)
                or transfer not in (1, 6, 13) or props.get('_Primaries', -1) not in (1, 5, 6)
                or props.get('_ChromaLocation', 0) not in range(6)):
            return 'unknown-color'
        if props.get('_FieldBased', -1) != 0:
            return 'interlaced'
        # `held` carries the output cadence in _DurationNum/_DurationDen; the
        # duration mpv measured for the source frame is kept under these names.
        num, den = props.get('_TigerestVfgSourceDurationNum', 0), props.get('_TigerestVfgSourceDurationDen', 0)
        verdict = timing.accept(index, Fraction(num, den) if num > 0 and den > 0 else None)
        if verdict in (CfrTiming.GAP, CfrTiming.UNTIMED):
            return verdict
        if not verdict:
            return 'vfr'
        if streaming and props.get('_TigerestLastFrame', -1) not in (0, 1):
            return 'runtime-eof-missing'
        return ''

    def route(matrix, color_range, chroma):
        key = (matrix, color_range, chroma)
        with graph_lock:
            if key not in routes:
                converted = core.resize.Bicubic(generated, format=layout.id, matrix=matrix, range=color_range,
                                                chromaloc=chroma, dither_type='ordered')
                # At a shot change the plugin repeats the earlier frame: show
                # the input frame itself instead of its RGB copy.
                routes[key] = core.tigerest_vfg.Substitute(stamp(converted, 1), bypass('cut'))
            return routes[key]

    def choose(n, f):
        if disabled:
            return bypass(disabled)
        props = f.props
        index, phase = divmod(n * step_num, step_den)
        if log:
            log.source(n, index, props)
        reason = eligibility(index, props)
        if reason in (CfrTiming.GAP, CfrTiming.UNTIMED):
            # Source frames went missing around this one: repeat it and
            # generate again from the next.
            if log and phase == 0:
                log.decision('repeated at a stall', reason, n, index, phase, props)
            return bypass(reason)
        if reason:
            return disable(reason, n, index, phase, props)
        if phase == 0:
            return bypass()
        last = props.get('_TigerestLastFrame') == 1 if streaming else index >= source.num_frames - 1
        if last:
            return bypass('eof')
        return route(props['_Matrix'], pixel_range(props), props.get('_ChromaLocation', 0))

    output = core.std.FrameEval(held, eval=choose, prop_src=held)
    if log:
        log.write(f'graph built: input {layout.name} {source.width}x{source.height} frames={source.num_frames} '
                  f'fps={source.fps_num}/{source.fps_den}; source rate {fps}, output rate {output_fps}, step {step}; '
                  f'mode {mode}, scene threshold {scene_threshold}, streaming {streaming}, monitor {monitor}, RGB {rgb.format.name}, '
                  f'threads {core.num_threads}, output frames={output.num_frames}')
        output = core.std.ModifyFrame(output, clips=output, selector=log.observe)
    if live:
        output = core.std.ModifyFrame(output, clips=output, selector=live.observe)
    if monitor:
        if not hasattr(core, 'tigerest'):
            core.std.LoadPlugin(path=options['plugin_path'])
        output = core.tigerest.Monitor(output, session=int(options.get('session', 0)),
                                       factor=step_den, factor_den=step_num)
    return output


options = json.loads(user_data)
runtime = Path(options['runtime_path']).resolve()
# Python's AddDllDirectory handle does not unregister when garbage collected.
# Give this VS instance a lease; its finalizer owns a separate cleanup stack so
# it cannot keep the lease itself alive after mpv clears the script globals.
dll_directories = ExitStack()
dll_directory_cleanup = None
try:
    for relative in ('python', 'python/Lib/site-packages/vapoursynth'):
        dll_directories.enter_context(os.add_dll_directory(str(runtime / relative)))
    dll_directory_cleanup = weakref.finalize(dll_directories, dll_directories.pop_all().close)
    vs.core.num_threads = int(options.get('threads', 4))
    vs.core.max_cache_size = int(options.get('cache_mb', 1024))
    if not hasattr(vs.core, 'tigerest_vfg'):
        vs.core.std.LoadPlugin(path=options['vfg_plugin_path'])
    build_vfg_filter(video_in, options).set_output()
except BaseException:
    if dll_directory_cleanup is not None:
        dll_directory_cleanup()
    else:
        dll_directories.close()
    raise
