#!/usr/bin/env python3
"""Run the VideoToolbox interpolation engine test on this Mac (ARC and manual
retain-release builds, address and undefined-behaviour sanitizers). The
engine is shared by the desktop libmpv and the iOS and tvOS apps."""
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
SOURCES = [ROOT / 'apple/Tests/native_vtfi_engine_test.m', ROOT / 'apple/NativeInterpolation/TigerestVTInterpolator.m']
with tempfile.TemporaryDirectory(prefix='vtfi-engine-test-') as tmp:
    for arc in ('-fobjc-arc', '-fno-objc-arc'):
        binary = Path(tmp) / ('test' + arc)
        subprocess.run(['xcrun', 'clang', '-O2', '-g', arc, '-Wall', '-Wextra', '-Werror', '-Wno-unused-parameter',
                        '-fsanitize=address,undefined', '-mmacosx-version-min=26.0',
                        '-I' + str(ROOT / 'apple/NativeInterpolation'), *map(str, SOURCES),
                        '-framework', 'Foundation', '-framework', 'CoreVideo', '-framework', 'VideoToolbox',
                        '-framework', 'CoreMedia', '-o', str(binary)], check=True)
        env = dict(os.environ, ASAN_OPTIONS='detect_leaks=0:halt_on_error=1', UBSAN_OPTIONS='halt_on_error=1')
        subprocess.run([str(binary)], env=env, check=True, timeout=120)
