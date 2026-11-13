import ctypes
import json
from ctypes import wintypes
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(os.name == 'nt', 'Windows process containment')
class WorkerJobTests(unittest.TestCase):
    def test_terminating_public_helper_terminates_worker_and_compiler(self):
        self.check_public_helper('prepare')

    def test_terminating_probe_helper_terminates_native_worker(self):
        self.check_public_helper('probe')

    def check_public_helper(self, kind):
        kernel = ctypes.WinDLL('kernel32.dll', use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            pid_file, worker_script, wrapper_script = base / 'pids.json', base / 'native.py', base / 'public.py'
            # Publish the PIDs atomically: the test reads the file once it exists.
            worker_script.write_text('import sys, subprocess, time, os, json\n'
                'child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])\n'
                f'with open({str(pid_file)!r} + ".tmp", "w") as f: f.write(json.dumps([os.getpid(), child.pid]))\n'
                f'os.replace({str(pid_file)!r} + ".tmp", {str(pid_file)!r})\n'
                'time.sleep(60)\n', encoding='utf-8')
            request = base / 'request.json'
            request.write_text(json.dumps({'runtime': str(base), 'cache': str(base / 'cache'),
                'model': 'rife-4.25-lite', 'width': 256, 'height': 128}), encoding='utf-8')
            # Stub runtime discovery only. Exercise the real public helper's
            # subprocess lifetime with a real nested worker/compiler chain.
            common = 'import sys\nfrom pathlib import Path\n' + \
                f'sys.path.insert(0, {str(ROOT / "dev/windows/rife")!r})\n'
            if kind == 'prepare':
                body = 'import prepare_engine as p\n' + \
                    f'p.verify_manifest = lambda root: {{"entrypoints": {{"python": {sys.executable!r}, "engineWorker": {str(worker_script)!r}}}}}\n'
                call = f'p.prepare(Path({str(request)!r}))\n'
            else:
                entrypoints = {'python': sys.executable, 'worker': str(worker_script),
                               'vsscript': str(worker_script), 'plugin': str(worker_script)}
                manifest = {'runtimeId': 'fixture', 'entrypoints': entrypoints,
                            'files': [{'path': path} for path in entrypoints.values()]}
                body = 'import probe_runtime as p\n' + \
                    f'p.verify_manifest = lambda root: {manifest!r}\n'
                call = f'p.probe(Path({str(base)!r}))\n'
            # The native fixture deliberately has no Job. Both wrappers must
            # contain their descendants independently of the worker's behavior.
            wrapper_script.write_text(common + body +
                'p.private_path = lambda root, path: Path(path)\np.isolated_environment = lambda *args: None\n' +
                call, encoding='utf-8')
            wrapper = subprocess.Popen([sys.executable, '-B', '-X', 'utf8', str(wrapper_script)],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            handles = []
            try:
                deadline = time.monotonic() + 5
                while not pid_file.is_file() and time.monotonic() < deadline and wrapper.poll() is None:
                    time.sleep(.05)
                self.assertTrue(pid_file.is_file(), 'worker did not start')
                handles = [kernel.OpenProcess(0x100001, False, pid) for pid in json.loads(pid_file.read_text())]
                self.assertTrue(all(handles))
                wrapper.kill()
                wrapper.wait(timeout=5)
                for handle in handles:
                    self.assertEqual(kernel.WaitForSingleObject(handle, 1500), 0,
                                     'public helper termination left a descendant alive')
            finally:
                if wrapper.poll() is None:
                    wrapper.kill()
                for handle in handles:
                    if handle:
                        kernel.TerminateProcess(handle, 1)
                        kernel.CloseHandle(handle)
                wrapper.communicate(timeout=5)

    def test_terminating_worker_also_terminates_its_compiler_child(self):
        kernel = ctypes.WinDLL('kernel32.dll', use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            pid_file = base / 'child.pid'
            script = base / 'worker.py'
            script.write_text('import os, sys, subprocess, time\n'
                f'sys.path.insert(0, {str(ROOT / "dev/windows/rife")!r})\n'
                'from windows_job import attach_cleanup_job\n'
                'job = attach_cleanup_job()\n'
                'child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])\n'
                f'with open({str(pid_file)!r} + ".tmp", "w") as f: f.write(str(child.pid))\n'
                f'os.replace({str(pid_file)!r} + ".tmp", {str(pid_file)!r})\n'
                'time.sleep(60)\n', encoding='utf-8')
            worker = subprocess.Popen([sys.executable, '-B', '-X', 'utf8', str(script)],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            child = None
            try:
                deadline = time.monotonic() + 5
                while not pid_file.is_file() and time.monotonic() < deadline and worker.poll() is None:
                    time.sleep(.05)
                if not pid_file.is_file():
                    worker.terminate()
                    output = worker.communicate(timeout=5)
                    self.fail(str(output))
                child = kernel.OpenProcess(0x100001, False, int(pid_file.read_text()))
                self.assertTrue(child)
                worker.kill()
                worker.wait(timeout=5)
                self.assertEqual(kernel.WaitForSingleObject(child, 5000), 0,
                                 'compiler must not survive cancellation or a worker crash')
            finally:
                if worker.poll() is None:
                    worker.kill()
                    worker.wait(timeout=5)
                worker.communicate(timeout=5)
                if child:
                    kernel.TerminateProcess(child, 1)
                    kernel.CloseHandle(child)


if __name__ == '__main__':
    unittest.main()
