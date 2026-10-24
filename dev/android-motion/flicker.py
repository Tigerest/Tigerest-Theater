"""Checks a screen recording frame by frame for flashes and stalls.

    python dev/android-motion/flicker.py <recording.mp4> [...]

Needs numpy, and ffmpeg/ffprobe on PATH or in FFMPEG_DIR. screenrecord only
writes a frame when the screen changes, so a run of frames closer than 40 ms
is one motion; intervals above 12 ms inside it are frames the display missed
at 120 Hz. A flash is one to four frames that leave the frame before them
while the frame after them is back where it was: the whole screen, or at
least two 15x15 blocks of a downscaled grey copy, such as a poster that
blanks and reappears.
"""
import os, subprocess, sys
import numpy as np

W, H, BLOCK = 135, 315, 15


def tool(name):
    folder = os.environ.get('FFMPEG_DIR')
    return os.path.join(folder, name) if folder else name


def frames(video):
    raw = subprocess.run([tool('ffmpeg'), '-v', 'quiet', '-i', video, '-fps_mode', 'passthrough',
                          '-vf', f'scale={W}:{H}:flags=area,format=gray', '-f', 'rawvideo', '-'],
                         capture_output=True, check=True).stdout
    pts = subprocess.run([tool('ffprobe'), '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                          'frame=pts_time', '-of', 'csv=p=0', video], capture_output=True, text=True, check=True).stdout.split()
    f = np.frombuffer(raw, dtype=np.uint8).reshape(-1, H, W).astype(np.float32)
    t = np.array([float(x) for x in pts]) * 1000
    assert len(f) == len(t), (len(f), len(t))
    return f, t


def check(video):
    f, t = frames(video)
    n = len(f)
    blocks = f.reshape(n, H // BLOCK, BLOCK, W // BLOCK, BLOCK).mean((2, 4))
    diff = lambda a, b: float(np.abs(f[a] - f[b]).mean())
    print(f'{video}: {n} frames, {t[-1] / 1000:.1f} s')
    start = 0
    for i in range(1, n + 1):
        if i < n and t[i] - t[i - 1] <= 40:
            continue
        if i - start > 5:
            gaps = [(round(t[k]), round(t[k] - t[k - 1], 1)) for k in range(start + 1, i) if t[k] - t[k - 1] > 12]
            print(f'  motion {t[start]:.0f}-{t[i - 1]:.0f} ms, {i - start} frames, missed: {gaps}')
        start = i
    flashes = []
    for i in range(1, n - 1):
        # Frames i..i+k-1 leave frame i-1, and frame i+k is back where it was.
        for k in range(1, 5):
            if i + k >= n:
                break
            e1, e2, e0 = diff(i - 1, i), diff(i + k - 1, i + k), diff(i - 1, i + k)
            b1, b2, b0 = (np.abs(blocks[a] - blocks[b]) for a, b in ((i - 1, i), (i + k - 1, i + k), (i - 1, i + k)))
            if e1 > 3 and e2 > 3 and e0 < .3 * (e1 + e2):
                flashes.append((i, k, 'screen'))
                break
            if ((b1 > 25) & (b2 > 25) & (b0 < .3 * (b1 + b2))).sum() >= 2:
                flashes.append((i, k, 'blocks'))
                break
    for i, k, kind in flashes:
        print(f'  flash? {k} frame(s) from {i} at {t[i]:.0f} ms ({kind})')
    print(f'  {len(flashes)} possible flashes')
    return len(flashes)


if __name__ == '__main__':
    sys.exit(1 if sum(check(v) for v in sys.argv[1:]) else 0)
