"""Exercise graph DLL-directory lifetime against the real Windows loader."""
import ctypes
import json
import os
from pathlib import Path
import runpy
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid


ROOT = Path(__file__).resolve().parents[1]
BRIDGE = ROOT / 'resources/mpv/rife/interpolate_trt.vpy'


@unittest.skipUnless(os.name == 'nt', 'requires Windows DLL search APIs')
class DllDirectoryLifetimeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='rife-dll-lifetime-')
        self.runtime = Path(self.temporary.name) / ('r' * 60)
        for relative in ('python', 'python/Lib/site-packages/vapoursynth',
                         'plugins', 'plugins/vsmlrt-cuda'):
            (self.runtime / relative).mkdir(parents=True, exist_ok=True)
        self.dll_name = 'rife-test-' + uuid.uuid4().hex + '.dll'
        shutil.copyfile(Path(os.environ['WINDIR']) / 'System32/version.dll',
                        self.runtime / 'python' / self.dll_name)
        self.handles = []
        self.real_add = os.add_dll_directory
        self.real_run = runpy.run_path
        self.original_path = list(sys.path)
        # Only the inference boundary is replaced; registration and DLL loads
        # use the production script and real Windows APIs.
        self.vs = SimpleNamespace(core=SimpleNamespace(trt=object()))

    def tearDown(self):
        for handle in reversed(self.handles):
            if handle.path is not None:
                handle.close()
        sys.path[:] = self.original_path
        self.temporary.cleanup()

    def add_directory(self, path):
        handle = self.real_add(path)
        self.handles.append(handle)
        return handle

    def build(self, source, options):
        return SimpleNamespace(set_output=lambda: None)

    def evaluate(self, add=None, build=None):
        def run(path, *args, **kwargs):
            if Path(path).name == 'trt_pipeline.py':
                return {'build_rife_filter': build or self.build}
            return self.real_run(path, *args, **kwargs)

        with patch.dict(sys.modules, {'vapoursynth': self.vs}), \
                patch.object(os, 'add_dll_directory', add or self.add_directory), \
                patch.object(runpy, 'run_path', side_effect=run):
            return self.real_run(str(BRIDGE), init_globals={
                'video_in': object(), 'user_data': json.dumps({
                    'runtime_path': str(self.runtime), 'trt_plugin_path': 'unused'})})

    def load_private_fixture(self):
        # LOAD_LIBRARY_SEARCH_USER_DIRS | LOAD_LIBRARY_SEARCH_SYSTEM32:
        # fixture lookup depends on our registration, not PATH/current dir.
        library = ctypes.WinDLL(self.dll_name, winmode=0xC00)
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.FreeLibrary.argtypes = [ctypes.c_void_p]
        kernel.FreeLibrary.restype = ctypes.c_int
        self.assertTrue(kernel.FreeLibrary(library._handle))

    def assert_private_directory_released(self):
        with self.assertRaises(OSError):
            self.load_private_fixture()

    def test_graph_disposal_removes_its_private_dll_search_directories(self):
        namespace = self.evaluate()
        self.load_private_fixture()
        namespace.clear()  # VSScript clears its environment during graph teardown.
        self.assert_private_directory_released()

    def test_repeated_graph_rebuilds_do_not_exhaust_windows_search_path(self):
        for rebuild in range(200):
            try:
                namespace = self.evaluate()
            except OSError as error:
                self.fail(f'graph rebuild {rebuild} exhausted DLL search paths '
                          f'(WinError {error.winerror})')
            namespace.clear()
        self.assert_private_directory_released()

    def test_repeated_graph_rebuilds_keep_the_private_import_path_unique(self):
        unrelated = 'rife-test-unrelated-import-directory'
        sys.path.insert(0, unrelated)
        for _ in range(4):
            namespace = self.evaluate()
            namespace.clear()
        # The bridge resolves runtime_path; %TEMP% can be an 8.3 short path.
        private_plugins = str(self.runtime.resolve() / 'plugins')
        self.assertEqual(sys.path.count(private_plugins), 1)
        self.assertEqual(sys.path[0], private_plugins)
        self.assertEqual(sys.path.count(unrelated), 1)

    def test_partial_registration_failure_rolls_back_opened_directories(self):
        def fail_third(path):
            if len(self.handles) == 2:
                raise OSError('controlled registration failure')
            return self.add_directory(path)

        with self.assertRaisesRegex(OSError, 'controlled registration failure'):
            self.evaluate(add=fail_third)
        self.assert_private_directory_released()

    def test_failed_graph_build_releases_registered_directories(self):
        def fail(source, options):
            raise RuntimeError('controlled graph failure')

        with self.assertRaisesRegex(RuntimeError, 'controlled graph failure'):
            self.evaluate(build=fail)
        self.assert_private_directory_released()


if __name__ == '__main__':
    unittest.main()
