#!/usr/bin/env python3
"""Replace a bundle's stock Qt WebEngine with the verified display-link engine.

The ordinary macOS build deploys whatever WebEngine the Qt SDK contains. The
stock 6.9.3 engine gives Chromium no CoreGraphics display ID, so the whole web
UI runs on a fixed 60 Hz timer. Releases since 2.6.1 ship the patched engine
(see dev/macos/qt/README.md). This copies that engine from an already verified
bundle and refuses any source whose QtWebEngineCore UUID is not the patched one.
Run dev/macos/sign_bundle.py and tests/test_macos_bundle.py afterwards.
"""
import argparse
import json
import os
import plistlib
import re
import shutil
import subprocess
from pathlib import Path

PATCHED_UUID = '76AE7891-C29A-31D6-815F-C1505E445F07'
FRAMEWORKS = ['QtWebEngineCore', 'QtWebEngineQuick', 'QtWebEngineQuickDelegatesQml']
# The source bundle keeps these as files under Resources/qml; the ordinary
# build places them in PlugIns/quick and links them from Resources/qml.
PLUGINS = {
    'libqtwebenginequickplugin.dylib': 'Resources/qml/QtWebEngine/libqtwebenginequickplugin.dylib',
    'libqtwebenginequickdelegatesplugin.dylib': 'Resources/qml/QtWebEngine/ControlsDelegates/libqtwebenginequickdelegatesplugin.dylib',
}


def engine_uuid(contents):
    binary = contents / 'Frameworks/QtWebEngineCore.framework/Versions/A/QtWebEngineCore'
    output = subprocess.run(['dwarfdump', '--uuid', str(binary)], check=True, capture_output=True, text=True).stdout
    match = re.search(r'UUID: ([0-9A-F-]+) \(arm64\)', output)
    return match.group(1) if match else None


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--source', required=True, type=Path, help='verified bundle carrying the patched engine')
    parser.add_argument('--bundle', required=True, type=Path, help='freshly deployed bundle to update')
    args = parser.parse_args()
    source, target = args.source / 'Contents', args.bundle / 'Contents'

    found = engine_uuid(source)
    if found != PATCHED_UUID:
        raise SystemExit(f'source engine {found} is not the patched engine {PATCHED_UUID}')
    for name in FRAMEWORKS:
        destination = target / 'Frameworks' / f'{name}.framework'
        if not destination.is_dir():
            raise SystemExit(f'missing deployed framework: {destination}')
        shutil.rmtree(destination)
        shutil.copytree(source / 'Frameworks' / f'{name}.framework', destination, symlinks=True)
        # sign_bundle.py signs every nested binary and container again.
        for signature in destination.rglob('_CodeSignature'):
            shutil.rmtree(signature)
    for name, relative in PLUGINS.items():
        destination = target / 'PlugIns/quick' / name
        if not destination.is_file():
            raise SystemExit(f'missing deployed plugin: {destination}')
        shutil.copyfile((source / relative).resolve(), destination)
    if engine_uuid(target) != PATCHED_UUID:
        raise SystemExit('bundle does not carry the patched engine after replacement')

    # Record where the engine came from, as release bundles do.
    root = Path(__file__).resolve().parents[2]
    origin = {}
    if (source / 'Resources/build-provenance.json').is_file():
        origin = json.loads((source / 'Resources/build-provenance.json').read_text())
    with open(target / 'Info.plist', 'rb') as info:
        version = plistlib.load(info).get('CFBundleShortVersionString')
    commit = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=root, check=True, capture_output=True, text=True).stdout.strip()
    provenance = {
        'type': 'ci' if os.environ.get('GITHUB_ACTIONS') == 'true' else 'local',
        'version': version, 'sourceCommit': commit,
        'qtWebEngineCoreUUID': PATCHED_UUID,
        'enginePatchCommit': origin.get('enginePatchCommit'), 'patches': origin.get('patches'),
        'engineSourceRelease': origin.get('version'), 'engineSourceCommit': origin.get('sourceCommit'),
    }
    (target / 'Resources/build-provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
    print(f'patched WebEngine {PATCHED_UUID} installed in {args.bundle}')


if __name__ == '__main__':
    main()
