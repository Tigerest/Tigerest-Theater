"""Validate actual Windows visual evidence against the portable release bundle."""
import argparse
import hashlib
import json
import re
import zipfile
from datetime import datetime
from pathlib import Path

PHASES = ('wall-windowed', 'wall-scrolled', 'wall-fullscreen')
MANUAL_SCENARIOS = ('real-library-hover', 'rapid-scroll-hover', 'detail-return',
                    'playback-return', 'fullscreen', 'settings-overlay')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate(report, bundle):
    require(isinstance(report, dict), 'Missing Windows compositor evidence')
    require(report.get('passed') is True and report.get('error', '') == '',
            'The latest displayed-pixel run is incomplete or failed')
    require(report.get('hardware') is True, 'An actual hardware GPU check is required')
    renderer = report.get('renderer', '')
    require(isinstance(renderer, str) and 'Direct3D11' in renderer and
            not re.search(r'WARP|SwiftShader|Microsoft Basic Render', renderer, re.I),
            'Software rendering cannot certify the hardware compositor path')
    phases = report.get('phases')
    require(isinstance(phases, list) and len(phases) == len(PHASES) and
            all(isinstance(p, dict) for p in phases), 'All displayed-pixel phases are required')
    require({p.get('name') for p in phases} == set(PHASES), 'Missing or duplicate pixel phase')
    for phase in phases:
        require(phase.get('code') == 0 and phase.get('error') == '' and
                phase.get('damagedFrames') == 0, 'Pixel check failed or capture was invalid')
        for field, minimum in (('frames', 40), ('moves', 100), ('samples', 4)):
            require(type(phase.get(field)) is int and phase[field] >= minimum,
                    f'Insufficient actual {field} in {phase["name"]}')
    control = report.get('negativeControl', {})
    require(isinstance(control, dict) and control.get('code') == 1 and
            control.get('error') == '' and type(control.get('damagedFrames')) is int and
            control['damagedFrames'] > 0, 'Missing successful pixel-detector negative control')
    manual = report.get('manual')
    require(isinstance(manual, dict) and manual.get('passed') is True and
            manual.get('observedCorruption') is False, 'Real media-library manual check is pending or failed')
    scenarios = manual.get('scenarios', {})
    require(isinstance(scenarios, dict) and
            all(scenarios.get(name) is True for name in MANUAL_SCENARIOS),
            'Hover, scroll, return, fullscreen and settings checks must all be completed')
    for field in ('refreshHz', 'mouseHz'):
        value = manual.get(field)
        require(type(value) in (int, float) and value > 0, f'Record the actual {field}')
    require(isinstance(manual.get('tester'), str) and manual['tester'].strip(), 'Missing manual tester')
    try:
        when = datetime.fromisoformat(manual.get('checkedAt', '').replace('Z', '+00:00'))
        require(when.tzinfo is not None, 'Manual timestamp must include timezone')
    except (ValueError, TypeError, AttributeError):
        raise ValueError('Missing valid manual check timestamp') from None
    with zipfile.ZipFile(bundle) as archive:
        names = {name.removeprefix('./'): name for name in archive.namelist()}
        for filename, field in (('Tigerest Theater.exe', 'exeSha256'), ('Qt6WebEngineCore.dll', 'coreSha256')):
            require(filename in names, f'Missing packaged {filename}')
            actual = hashlib.sha256(archive.read(names[filename])).hexdigest()
            require(report.get(field) == actual, f'{filename} differs from the visually tested bundle')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--bundle', type=Path, required=True)
    args = parser.parse_args()
    validate(json.loads(args.report.read_text(encoding='utf-8-sig')), args.bundle)
    print('PASS: exact Windows bundle, hardware displayed-pixel evidence and real-library manual checks')


if __name__ == '__main__':
    main()
