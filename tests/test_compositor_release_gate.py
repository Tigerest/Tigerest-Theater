import copy
import hashlib
import importlib.util
import tempfile
import unittest
import zipfile
from pathlib import Path

source = Path(__file__).resolve().parents[1] / 'dev/windows/verify_compositor_release.py'
spec = importlib.util.spec_from_file_location('compositor_gate', source)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class CompositorReleaseGateTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.bundle = Path(self.directory.name) / 'TigerestTheater-2.5.4-x64.zip'
        with zipfile.ZipFile(self.bundle, 'w') as archive:
            archive.writestr('Tigerest Theater.exe', b'executable under test')
            archive.writestr('Qt6WebEngineCore.dll', b'actual webengine runtime')
        self.report = {
            'passed': True,
            'exeSha256': hashlib.sha256(b'executable under test').hexdigest(),
            'coreSha256': hashlib.sha256(b'actual webengine runtime').hexdigest(),
            'hardware': True, 'renderer': 'ANGLE (NVIDIA RTX 4090 Direct3D11)',
            'negativeControl': {'code': 1, 'error': '', 'damagedFrames': 1},
            'phases': [{'name': name, 'code': 0, 'frames': 80, 'moves': 500,
                        'samples': 6, 'damagedFrames': 0, 'error': ''}
                       for name in ('wall-windowed', 'wall-scrolled', 'wall-fullscreen')],
            'manual': {'passed': True, 'observedCorruption': False,
                       'refreshHz': 240, 'mouseHz': 1000,
                       'checkedAt': '2026-10-10T23:00:00+08:00', 'tester': 'local tester',
                       'scenarios': {name: True for name in (
                           'real-library-hover', 'rapid-scroll-hover', 'detail-return',
                           'playback-return', 'fullscreen', 'settings-overlay')}}}

    def test_accepts_actual_bundle_with_complete_evidence(self):
        gate.validate(self.report, self.bundle)

    def test_rejects_previous_release_executable_or_runtime(self):
        for field in ('exeSha256', 'coreSha256'):
            report = copy.deepcopy(self.report)
            report[field] = '0' * 64
            with self.subTest(field=field), self.assertRaises(ValueError):
                gate.validate(report, self.bundle)

    def test_rejects_missing_or_failed_displayed_pixel_test(self):
        for field, value in (('passed', False), ('passed', None), ('phases', []), ('hardware', False),
                             ('renderer', 'ANGLE Direct3D11 WARP'), ('negativeControl', {})):
            report = copy.deepcopy(self.report)
            report[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                gate.validate(report, self.bundle)
        for field, value in (('frames', 0), ('damagedFrames', 1), ('error', 'occluded'), ('code', 1)):
            report = copy.deepcopy(self.report)
            report['phases'][0][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                gate.validate(report, self.bundle)

    def test_rejects_missing_real_media_check_or_known_corruption(self):
        for field, value in (('manual', None),):
            report = copy.deepcopy(self.report)
            report[field] = value
            with self.assertRaises(ValueError):
                gate.validate(report, self.bundle)
        for field, value in (('passed', False), ('observedCorruption', True), ('refreshHz', 0)):
            report = copy.deepcopy(self.report)
            report['manual'][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                gate.validate(report, self.bundle)
        report = copy.deepcopy(self.report)
        report['manual']['scenarios']['playback-return'] = False
        with self.assertRaises(ValueError):
            gate.validate(report, self.bundle)


if __name__ == '__main__':
    unittest.main()
