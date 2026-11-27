"""Prepare the VapourSynth runtime that ships with the Windows player.

NVIDIA frame generation (VFG) and any vapoursynth filter in mpv.conf run on
this runtime when the RIFE extension is not installed; with the extension the
player uses the extension's copy of the same Python and VapourSynth. It is the
extension's private `python` directory without TensorRT or models: CPython's
embeddable package and the VapourSynth portable wheel that
dev/windows/rife/runtime-lock.json pins, with a `_pth` of its own.

    python dev/windows/vapoursynth/prepare_vapoursynth_runtime.py --output DIR
    python dev/windows/vapoursynth/prepare_vapoursynth_runtime.py --output DIR --from-runtime RIFE_RUNTIME
    python dev/windows/vapoursynth/prepare_vapoursynth_runtime.py --output DIR --write-lock

Without --from-runtime the two archives are downloaded into build/rife/downloads
(or --archives DIR; --offline uses only what is there) and checked against the
RIFE lock. --from-runtime copies the `python` directory of a RIFE extension
runtime instead. Either way the result must match runtime-lock.json file for
file; an existing output is verified and a mismatching one is rejected.
--write-lock records the prepared directory in the lock instead of checking it
(maintainers, when the RIFE lock moves to another Python or VapourSynth).
"""
import argparse
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import zipfile

HERE = Path(__file__).resolve().parent
RIFE = HERE.parent / 'rife'
sys.path.insert(0, str(RIFE))
from prepare_runtime import acquire, extract_zip  # noqa: E402
from probe_runtime import file_hash, private_path  # noqa: E402

LOCK = HERE / 'runtime-lock.json'
RIFE_LOCK = RIFE / 'runtime-lock.json'
# The extension's _pth adds ../scripts for its RIFE helpers; this runtime has none.
PTH_NAME = 'python313._pth'
PTH = 'python313.zip\n.\nLib/site-packages\n'
LICENSES = {
    'python': 'python/LICENSE.txt',
    'vapoursynth': 'python/Lib/site-packages/vapoursynth-79.dist-info/licenses/COPYING.LESSER',
}


def runtime_files(root):
    return {path.relative_to(root).as_posix(): {'size': path.stat().st_size, 'sha256': file_hash(path)}
            for path in sorted(root.rglob('*')) if path.is_file()}


def verify(root, lock):
    actual = runtime_files(root)
    expected = lock['files']
    missing = sorted(set(expected) - set(actual))
    extra = sorted(set(actual) - set(expected))
    changed = sorted(path for path in set(expected) & set(actual) if expected[path] != actual[path])
    if missing or extra or changed:
        raise ValueError('VapourSynth runtime does not match the lock: missing %s, unexpected %s, changed %s'
                         % (missing[:5], extra[:5], changed[:5]))


def from_archives(python, archives, offline):
    rife_lock = json.loads(RIFE_LOCK.read_text(encoding='utf-8'))
    entries = {entry['id']: entry for entry in rife_lock['archives']}
    directory = archives.resolve()
    with zipfile.ZipFile(acquire(entries['python'], directory, offline)) as archive:
        extract_zip(archive, python)
    with zipfile.ZipFile(acquire(entries['vapoursynth'], directory, offline)) as archive:
        wheels = [name for name in archive.namelist() if name.endswith('.whl')]
        if len(wheels) != 1:
            raise ValueError('Expected one VapourSynth portable wheel')
        with zipfile.ZipFile(io.BytesIO(archive.read(wheels[0]))) as wheel:
            extract_zip(wheel, python / 'Lib/site-packages', skip_debug=True)


def from_runtime(python, source):
    source = source.resolve() / 'python'
    if not (source / 'python.exe').is_file():
        raise ValueError('Not a RIFE runtime (no python/python.exe): ' + str(source.parent))
    for path in sorted(source.rglob('*')):
        if path.is_file() and path.relative_to(source).as_posix() != PTH_NAME:
            target = private_path(python, path.relative_to(source).as_posix())
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)


def write_lock(root):
    rife_lock = json.loads(RIFE_LOCK.read_text(encoding='utf-8'))
    files = runtime_files(root)
    for path in LICENSES.values():
        if path not in files:
            raise ValueError('License file missing: ' + path)
    lock = {
        'schemaVersion': 1,
        'runtime': 'vapoursynth',
        'versions': {key: rife_lock['versions'][key] for key in ('python', 'vapoursynth')},
        'source': "CPython's embeddable package and VapourSynth's portable wheel, unmodified, as pinned by "
                  'dev/windows/rife/runtime-lock.json; python/' + PTH_NAME + ' is written by this tool',
        'licenses': LICENSES,
        'files': files,
    }
    LOCK.write_text(json.dumps(lock, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    print('wrote', LOCK, len(files), 'files', sum(entry['size'] for entry in files.values()), 'bytes')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--from-runtime', type=Path, help='a RIFE extension runtime to copy python/ from')
    parser.add_argument('--archives', type=Path, default=HERE.parents[2] / 'build/rife/downloads')
    parser.add_argument('--offline', action='store_true')
    parser.add_argument('--write-lock', action='store_true',
                        help='record the prepared runtime in runtime-lock.json instead of checking it')
    args = parser.parse_args()
    if not args.output:
        parser.error('--output is required')
    try:
        lock = json.loads(LOCK.read_text(encoding='utf-8'))
        if lock.get('schemaVersion') != 1:
            raise ValueError('Unsupported VapourSynth runtime lock')
        output = args.output.resolve()
        if output.exists():
            if args.write_lock:
                write_lock(output)
            else:
                verify(output, lock)
                print('verified', output)
            return
        output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix='vapoursynth-build-', dir=output.parent) as temporary:
            root = Path(temporary) / 'runtime'
            python = root / 'python'
            python.mkdir(parents=True)
            if args.from_runtime:
                from_runtime(python, args.from_runtime)
            else:
                from_archives(python, args.archives, args.offline)
            (python / PTH_NAME).write_text(PTH, encoding='utf-8', newline='\n')
            if not args.write_lock:
                verify(root, lock)
            os.rename(root, output)
        if args.write_lock:
            write_lock(output)
            return
        print(json.dumps({'runtime': str(output), 'files': len(lock['files']),
                          'bytes': sum(entry['size'] for entry in lock['files'].values())}))
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()
