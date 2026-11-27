"""Pictures of the player for the usage tour (native/tour-art), see capture.cjs.

    python dev/windows/tour-art/compose.py clip   # build/tour-art/clip.mkv
    python dev/windows/tour-art/compose.py        # build/tour-art/raw -> native/tour-art

The clip is the client's own home art (native/home-art/anime.png) as a 40-second
23.976 fps film with a slow zoom, so the playing picture has motion for the frame
statistics and nothing in it needs a licence. FFmpeg comes from $FFMPEG or PATH.

The pictures are 1280x684, the default test window's page; the tour's numbered
marks (ART in native/onboardingTour.js) are in percent of that. Professional mode
is the page's panels with mpv's own picture pasted into the stage, since the page
capture leaves the video area empty. Needs Pillow with WebP.
"""
import argparse
import json
import os
import shutil
import subprocess
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
WORK = ROOT / 'build' / 'tour-art'
SIZE = (1280, 684)


def report(path):
    # Inside the checkout, relative: consoles mangle the folder's Chinese name.
    shown = path.resolve().relative_to(ROOT) if path.resolve().is_relative_to(ROOT) else path
    print(f'{shown}: {path.stat().st_size} bytes')


def clip():
    ffmpeg = os.environ.get('FFMPEG') or shutil.which('ffmpeg')
    if not ffmpeg:
        raise SystemExit('FFmpeg not found: put it on PATH or set FFMPEG')
    WORK.mkdir(parents=True, exist_ok=True)
    out = WORK / 'clip.mkv'
    picture = ("[0:v]crop=1536:864:0:60,scale=3840:2160:flags=lanczos,"
               "zoompan=z='1+0.00008*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=24000/1001,"
               "format=yuv420p[v]")
    subprocess.run([ffmpeg, '-hide_banner', '-loglevel', 'error', '-y',
                    '-loop', '1', '-framerate', '24000/1001', '-t', '40', '-i', str(ROOT / 'native' / 'home-art' / 'anime.png'),
                    '-f', 'lavfi', '-t', '40', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
                    '-filter_complex', picture, '-map', '[v]', '-map', '1:a',
                    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-tune', 'animation',
                    '-c:a', 'aac', '-b:a', '96k', '-shortest', str(out)], check=True)
    report(out)


def compose(raw, out):
    info = json.loads((raw / 'info.json').read_text(encoding='utf-8'))
    view = info['viewport']
    if (view['w'], view['h']) != SIZE:
        raise SystemExit(f"captured a {view['w']}x{view['h']} page; the tour's marks assume {SIZE[0]}x{SIZE[1]}")
    load = lambda name: Image.open(raw / name).convert('RGB')
    pro = load('pro-page.png')
    stage = info['stage']
    pro.paste(load('pro-window.png'), (round(stage['left'] * stage['dpr']), round(stage['top'] * stage['dpr'])))
    out.mkdir(parents=True, exist_ok=True)
    for name, picture in [('player', load('player-window.png')), ('pro-mode', pro), ('interpolation', load('settings-video.png'))]:
        path = out / f'{name}.webp'
        picture.resize(SIZE, Image.LANCZOS).save(path, 'WEBP', quality=84, method=6)
        report(path)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('step', nargs='?', choices=['clip'], help='make the demo clip instead of the pictures')
    parser.add_argument('--raw', type=Path, default=WORK / 'raw', help='the captures (capture.cjs)')
    parser.add_argument('--out', type=Path, default=ROOT / 'native' / 'tour-art')
    arguments = parser.parse_args()
    clip() if arguments.step == 'clip' else compose(arguments.raw, arguments.out)
