#!/usr/bin/env python3
"""Prepare the private mpv headers and filter registries for the Apple-native
interpolation filter (apple/NativeInterpolation) in the iOS and tvOS apps.

MPVKit ships mpv as a static archive. Like prepare_native_rife.py, this writes
a copy of mpv's filters/user_filters.c whose list starts with our filters; the
apps compile it, so it links before the archive and every built-in filter
stays. Three registries: the iOS app with and without the iPad RIFE filter,
and the tvOS app (interpolation only). Headers come from the pinned mpv source
(a checkout at REVISION, or the verified copy prepare_native_rife.py made) and
from the exact MPVKit artifacts the Swift packages resolved. Nothing installed
is modified; the output is ignored by git (apple/Generated).
"""
import argparse
import json
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
REVISION = '41f6a645068483470267271e1d09966ca3b9f413'
MPVKIT = 'd9194243bdc68b87d8989376ab52aee7da6c8e0b'
CONFIG = ('#define HAVE_POSIX 1\n#define HAVE_VULKAN 1\n#define HAVE_GL 1\n#define HAVE_EGL 0\n#define HAVE_ZIMG 0\n'
          '#define HAVE_VAPOURSYNTH 0\n#define HAVE_RUBBERBAND 0\n#define HAVE_VDPAU 0\n#define HAVE_VAAPI 0\n'
          '#define HAVE_D3D_HWACCEL 0\n#define HAVE_GPL 0\n')
SLICES = [('device', 'ios-arm64'), ('simulator', 'ios-arm64_x86_64-simulator'),
          ('tvos', 'tvos-arm64_arm64e'), ('tvsimulator', 'tvos-arm64_x86_64-simulator')]


def mpv_source(argument):
    if argument:
        source = argument.resolve()
        head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip()
        assert head == REVISION, f'mpv source is at {head}, not {REVISION}'
        assert not subprocess.check_output(['git', 'diff', '--name-only', 'HEAD'], cwd=source, text=True).strip(), \
            'mpv source has local changes'
        return source
    record = ROOT / 'apple/Generated/NativeRIFE/source.json'
    assert record.exists(), 'Pass --mpv-source (an mpv checkout at %s), or run prepare_native_rife.py first' % REVISION
    assert json.loads(record.read_text())['revision'] == REVISION, 'apple/Generated/NativeRIFE is from another mpv revision'
    return ROOT / 'apple/Generated/NativeRIFE/mpv'


def registry(text, entries):
    anchor = 'const struct mp_user_filter_entry *vf_list[] = {'
    assert text.count(anchor) == 1, 'mpv filters/user_filters.c changed shape'
    externs = ''.join(f'extern const struct mp_user_filter_entry {name};\n' for name in entries)
    listed = ''.join(f'\n    &{name},' for name in entries)
    return text.replace(anchor, externs + anchor + listed)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mpv-source', type=Path)
    args = parser.parse_args()
    source = mpv_source(args.mpv_source)
    out = ROOT / 'apple/Generated/NativeFilters'
    out.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, out / 'mpv', dirs_exist_ok=True, ignore=shutil.ignore_patterns('.git'))
    (out / 'config.h').write_text(CONFIG)
    filters = (source / 'filters/user_filters.c').read_text()
    (out / 'user_filters_ios.c').write_text(registry(filters, ['vf_tigerest_vtfi']))
    (out / 'user_filters_ios_rife.c').write_text(registry(filters, ['vf_tigerest_rife', 'vf_tigerest_vtfi']))
    (out / 'user_filters_tv.c').write_text(registry(filters, ['vf_tigerest_vtfi']))
    artifacts = ROOT / 'apple/DerivedData/SourcePackages/artifacts/mpvkit'
    for variant, slice_name in SLICES:
        headers = out / variant
        headers.mkdir(exist_ok=True)
        for framework, include in [('Libavutil', 'libavutil'), ('Libplacebo', 'libplacebo')]:
            paths = list((artifacts / framework).glob(f'*.xcframework/{slice_name}/{framework}.framework/Headers'))
            assert len(paths) == 1, (framework, slice_name, 'resolve the MPVKit package first')
            target = headers / include
            if target.is_symlink() or target.exists():
                target.unlink()
            target.symlink_to(paths[0])
    (out / 'source.json').write_text(json.dumps({'mpv': 'https://github.com/mpv-player/mpv', 'revision': REVISION,
                                                 'mpvkit': MPVKIT}, indent=2) + '\n')
    print('Native filter headers and registries prepared in', out)


if __name__ == '__main__':
    main()
