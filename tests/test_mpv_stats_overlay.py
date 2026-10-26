"""Headless libmpv Lua contract checks; not a GPU or playback benchmark.

Windows: dot-source dev/windows/Enter-TestEnvironment.ps1 before running.
"""
import ctypes
import json
import os
from pathlib import Path
import re
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]


class StatsOverlayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        dll = Path(os.environ.get('TIGEREST_STATS_MPV_DLL', ROOT / 'build/output/libmpv-2.dll'))
        cls.mpv = ctypes.CDLL(str(dll))
        api = cls.mpv
        api.mpv_create.restype = ctypes.c_void_p
        api.mpv_set_option_string.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p]
        api.mpv_initialize.argtypes = [ctypes.c_void_p]
        api.mpv_command.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_char_p)]
        api.mpv_get_property_string.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
        api.mpv_get_property_string.restype = ctypes.c_void_p
        api.mpv_free.argtypes = [ctypes.c_void_p]
        api.mpv_terminate_destroy.argtypes = [ctypes.c_void_p]

    def setUp(self):
        self.handle = self.mpv.mpv_create()
        self.assertTrue(self.handle)
        self.addCleanup(self.mpv.mpv_terminate_destroy, self.handle)
        opts = {'config': 'no', 'terminal': 'no', 'vo': 'null', 'ao': 'null',
                'load-scripts': 'no', 'load-stats-overlay': 'no',
                'scripts': str(ROOT / 'tests/fixtures/tigerest_stats_probe.lua')}
        for key, value in opts.items():
            self.assertGreaterEqual(self.mpv.mpv_set_option_string(
                self.handle, key.encode(), value.encode('utf-8')), 0)
        self.assertGreaterEqual(self.mpv.mpv_initialize(self.handle), 0)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if self.prop('user-data/tigerest-stats-test/ready') is True:
                break
            time.sleep(.02)
        else:
            self.fail('stats Lua fixture did not initialize')

    def prop(self, name):
        ptr = self.mpv.mpv_get_property_string(self.handle, name.encode())
        if not ptr:
            return ''
        try:
            return json.loads(ctypes.string_at(ptr).decode('utf-8'))
        finally:
            self.mpv.mpv_free(ptr)

    def render(self, scenario):
        command = (ctypes.c_char_p * 4)(b'script-message', b'tigerest-stats-probe',
                                         scenario.encode(), None)
        self.assertGreaterEqual(self.mpv.mpv_command(self.handle, command), 0)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if self.prop('user-data/tigerest-stats-test/done') is True:
                self.assertEqual(self.prop('user-data/tigerest-stats-test/error'), '')
                # mpv's OSD ASS-escaping control markers surround property text.
                return re.sub(r'\x92[at][01]', '',
                              self.prop('user-data/tigerest-stats-test/output'))
            time.sleep(.02)
        self.fail('stats Lua fixture did not answer')

    def test_audio_sync_hides_display_estimate_and_jitter(self):
        output = self.render('audio')
        self.assertIn('120.000', output)
        self.assertNotIn('119.999', output)
        self.assertNotIn('0.125', output)

    def test_active_display_sync_keeps_measured_estimate_and_jitter(self):
        output = self.render('display')
        self.assertIn('119.999', output)
        self.assertIn('0.125', output)

    def test_processing_page_keeps_real_pass_timings(self):
        output = self.render('detail')
        self.assertIn('fixture shader pass', output)
        self.assertRegex(output, r'1200\s*/\s*800\s*/\s*2000')

    def test_processing_graphs_render_by_default(self):
        output = self.render('detail')
        self.assertIn('fixture shader pass', output)
        self.assertIn('\\p1', output)
        self.assertIn('\\p0', output)

    def test_output_drops_are_visible_when_decoder_counter_is_unavailable(self):
        self.assertRegex(self.render('output-only'), r'7\s*\(')

    def test_help_page_is_available_through_original_page_binding_contract(self):
        self.assertTrue(self.render('help'))

    def test_internal_rife_filter_shows_model_and_factor_without_private_paths(self):
        output = self.render('rife')
        self.assertIn('@tigerest-rife: vapoursynth', output)
        self.assertIn('rife-v4.26', output)
        self.assertIn('2x', output)
        self.assertNotIn('C:/private', output)
        self.assertNotIn('engine_path', output)
        raw = self.prop('user-data/tigerest-stats-test/filters')
        self.assertEqual(raw[0]['params']['file'], 'C:/private/rife/interpolate.vpy')
        self.assertEqual(json.loads(raw[0]['params']['user-data']), {
            'factor': 2, 'model_path': 'rife-v4.26',
            'engine_path': 'C:/private/rife/engine.plan',
            'runtime_path': 'C:/private/runtime'})

    def test_path_valued_rife_model_displays_only_the_model_name(self):
        output = self.render('rife-path-model')
        self.assertIn('rife-v4.26', output)
        self.assertIn('2x', output)
        self.assertNotIn('private', output)

    def test_malformed_internal_rife_metadata_does_not_expose_runtime_parameters(self):
        output = self.render('rife-invalid')
        self.assertIn('@tigerest-rife: vapoursynth', output)
        self.assertNotIn('C:/private', output)
        self.assertNotIn('broken-json', output)

    def test_other_vapoursynth_filters_keep_their_original_parameters(self):
        output = self.render('other-filter')
        self.assertIn('@custom-vs: vapoursynth', output)
        self.assertIn('file=C:/private/rife/interpolate.vpy', output)
        self.assertIn('engine_path', output)


if __name__ == '__main__':
    unittest.main()
