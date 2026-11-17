"""Exercise the NVIDIA frame generation runtime's preparation, check and deployment."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CMAKE = os.environ.get("CMAKE_COMMAND") or shutil.which("cmake")
LOCK = ROOT / "dev/windows/nvidia-vfx/runtime-lock.json"
RUNTIME = {"NVVideoEffects.dll": b"effects", "NVCVImage.dll": b"cvimage",
           "nvVFXVideoFrameGeneration.dll": b"frame-generation", "cudart64_12.dll": b"cudart",
           "nvngxruntime.dll": b"ngx"}
LICENSES = {"NVIDIA-Software-License-Agreement-2025.05.05.pdf": b"agreement", "THIRD_PARTY.md": b"third party"}


def fixture_lock(wheel=None):
    entry = lambda payload, member: {"member": member, "size": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
    lock = {"schemaVersion": 1,
            "runtime": {name: entry(data, "nvvfx/libs/" + name) for name, data in RUNTIME.items()},
            "licenses": {name: entry(data, "dist-info/licenses/" + name) for name, data in LICENSES.items()}}
    if wheel:
        data = wheel.read_bytes()
        lock["wheel"] = {"file": wheel.name, "url": "https://invalid.example/" + wheel.name,
                         "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    return lock


def write_runtime(directory, missing=None, corrupt=None):
    (directory / "licenses").mkdir(parents=True)
    for name, data in RUNTIME.items():
        if name != missing:
            (directory / name).write_bytes(b"wrong" if name == corrupt else data)
    for name, data in LICENSES.items():
        if name != missing:
            (directory / "licenses" / name).write_bytes(b"wrong" if name == corrupt else data)


class NvidiaVfxDeployment(unittest.TestCase):
    def run_cmake(self, root, runtime, lock, *, deploy=True):
        lock_path = root / "lock.json"
        lock_path.write_text(json.dumps(lock), encoding="utf-8")
        notice = root / "NOTICE.txt"
        notice.write_text("notice", encoding="utf-8")
        output = root / "bundle"
        script = root / "run.cmake"
        call = (f'tigerest_deploy_nvidia_vfx("{runtime.as_posix()}" "{lock_path.as_posix()}" "{notice.as_posix()}" "{output.as_posix()}")'
                if deploy else f'tigerest_validate_nvidia_vfx("{runtime.as_posix()}" "{lock_path.as_posix()}")')
        script.write_text(f'include("{ROOT.as_posix()}/CMakeModules/DeployWindowsNvidiaVfx.cmake")\n{call}\n', encoding="utf-8")
        result = subprocess.run([CMAKE, "-P", str(script)], capture_output=True, encoding="utf-8", errors="replace")
        files = {p.relative_to(output).as_posix(): p.read_bytes() for p in output.rglob("*") if p.is_file()}
        return result, files

    def test_exact_runtime_licenses_lock_and_notice_are_deployed(self):
        with tempfile.TemporaryDirectory(prefix="tigerest-vfx-deploy-") as temporary:
            root = Path(temporary)
            runtime = root / "中文 NVIDIA runtime"
            write_runtime(runtime)
            result, files = self.run_cmake(root, runtime, fixture_lock())
            self.assertEqual(result.returncode, 0, result.stderr)
            for name, data in RUNTIME.items():
                self.assertEqual(files["vfg/nvidia/" + name], data)
            for name, data in LICENSES.items():
                self.assertEqual(files["licenses/nvidia-vfx/" + name], data)
            self.assertEqual(files["licenses/nvidia-vfx/NOTICE.txt"], b"notice")
            self.assertIn("licenses/nvidia-vfx/runtime-lock.json", files)
            self.assertEqual(len(files), len(RUNTIME) + len(LICENSES) + 2)

    def test_missing_or_corrupt_files_fail_before_deploying_anything(self):
        for name in [*RUNTIME, *LICENSES]:
            for mode in ("missing", "corrupt"):
                with self.subTest(file=name, mode=mode), tempfile.TemporaryDirectory(prefix="tigerest-vfx-deploy-") as temporary:
                    root = Path(temporary)
                    write_runtime(root / "runtime", **{mode: name})
                    result, files = self.run_cmake(root, root / "runtime", fixture_lock())
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("Verified NVIDIA runtime", result.stderr)
                    self.assertEqual(files, {})

    def test_missing_directory_names_the_variable(self):
        with tempfile.TemporaryDirectory(prefix="tigerest-vfx-deploy-") as temporary:
            root = Path(temporary)
            result, _ = self.run_cmake(root, root / "absent", fixture_lock(), deploy=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("TIGEREST_NVIDIA_VFX_RUNTIME_DIR", result.stderr)

    def prepare(self, root, lock, *arguments):
        # The script reads the lock and NOTICE next to itself; run a copy beside a fixture lock.
        tool = root / "tool"
        tool.mkdir(exist_ok=True)
        shutil.copyfile(ROOT / "dev/windows/nvidia-vfx/prepare_nvidia_vfx_runtime.py", tool / "prepare.py")
        (tool / "runtime-lock.json").write_text(json.dumps(lock), encoding="utf-8")
        (tool / "NOTICE.txt").write_text("notice", encoding="utf-8")
        return subprocess.run([sys.executable, "-I", str(tool / "prepare.py"), "--output", str(root / "out"), *arguments],
                              capture_output=True, encoding="utf-8", errors="replace")

    def test_preparation_extracts_only_locked_members_from_a_verified_wheel(self):
        with tempfile.TemporaryDirectory(prefix="tigerest-vfx-prepare-") as temporary:
            root = Path(temporary)
            wheel = root / "nvidia_vfx-test.whl"
            with zipfile.ZipFile(wheel, "w") as archive:
                for name, data in RUNTIME.items():
                    archive.writestr("nvvfx/libs/" + name, data)
                for name, data in LICENSES.items():
                    archive.writestr("dist-info/licenses/" + name, data)
                archive.writestr("nvvfx/libs/nvngx_truehdr.dll", b"not shipped")
            result = self.prepare(root, fixture_lock(wheel), "--wheel", str(wheel), "--offline")
            self.assertEqual(result.returncode, 0, result.stderr)
            staged = sorted(p.relative_to(root / "out").as_posix() for p in (root / "out").rglob("*") if p.is_file())
            self.assertEqual(staged, sorted([*RUNTIME, *("licenses/" + n for n in LICENSES), "NOTICE.txt", "runtime-lock.json"]))
            self.assertEqual((root / "out/nvVFXVideoFrameGeneration.dll").read_bytes(), b"frame-generation")
            # Existing output is verified, not staged again, and a changed file is rejected.
            again = self.prepare(root, fixture_lock(wheel), "--wheel", str(wheel), "--offline")
            self.assertEqual(again.returncode, 0, again.stderr)
            self.assertIn("Verified existing NVIDIA runtime", again.stdout)
            (root / "out/NVCVImage.dll").write_bytes(b"replaced")
            rejected = self.prepare(root, fixture_lock(wheel), "--wheel", str(wheel), "--offline")
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("checksum/size mismatch: NVCVImage.dll", rejected.stderr)

    def test_preparation_rejects_an_unverified_wheel_without_staging(self):
        with tempfile.TemporaryDirectory(prefix="tigerest-vfx-prepare-") as temporary:
            root = Path(temporary)
            wheel = root / "nvidia_vfx-test.whl"
            wheel.write_bytes(b"genuine")
            lock = fixture_lock(wheel)
            wheel.write_bytes(b"tampered")
            result = self.prepare(root, lock, "--wheel", str(wheel), "--offline")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("NVIDIA wheel checksum/size mismatch", result.stderr)
            self.assertFalse((root / "out").exists())

    def test_preparation_missing_offline_wheel_is_terminal(self):
        with tempfile.TemporaryDirectory(prefix="tigerest-vfx-prepare-") as temporary:
            root = Path(temporary)
            lock = fixture_lock()
            lock["wheel"] = {"file": "absent.whl", "url": "https://invalid.example/absent.whl", "size": 1, "sha256": "0" * 64}
            result = self.prepare(root, lock, "--wheel", str(root / "absent.whl"), "--offline")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Offline wheel missing", result.stderr)
            self.assertFalse((root / "out").exists())

    def test_preparation_from_loose_files_checks_each_file(self):
        for corrupt in (None, "cudart64_12.dll", "THIRD_PARTY.md"):
            with self.subTest(corrupt=corrupt), tempfile.TemporaryDirectory(prefix="tigerest-vfx-prepare-") as temporary:
                root = Path(temporary)
                write_runtime(root / "loose", corrupt=corrupt)
                result = self.prepare(root, fixture_lock(), "--from-dir", str(root / "loose"),
                                      "--licenses-from", str(root / "loose/licenses"))
                if corrupt:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("checksum/size mismatch: " + corrupt, result.stderr)
                    self.assertFalse((root / "out").exists())
                else:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual((root / "out/licenses/THIRD_PARTY.md").read_bytes(), b"third party")

    def test_checked_in_lock_covers_what_the_player_loads(self):
        lock = json.loads(LOCK.read_text(encoding="utf-8"))
        self.assertEqual(lock["schemaVersion"], 1)
        self.assertRegex(lock["wheel"]["url"], r"^https://pypi\.nvidia\.com/nvidia-vfx/")
        self.assertRegex(lock["wheel"]["sha256"], r"^[0-9a-f]{64}$")
        for group in ("runtime", "licenses"):
            for name, entry in lock[group].items():
                self.assertRegex(entry["sha256"], r"^[0-9a-f]{64}$", name)
                self.assertGreater(entry["size"], 0, name)
        self.assertTrue(all(e["member"].startswith("nvvfx/libs/") for e in lock["runtime"].values()))
        self.assertIn("NVIDIA-Software-License-Agreement-2025.05.05.pdf", lock["licenses"])
        # Every file the player requires before it offers VFG ships with the package.
        source = (ROOT / "src/player/PlayerComponent.cpp").read_text(encoding="utf-8")
        check = source[source.index("struct VfgFiles"):source.index("bool complete()", source.index("struct VfgFiles"))]
        required = set(re.findall(r'"([A-Za-z0-9_]+\.dll)"', check))
        self.assertTrue({"NVVideoEffects.dll", "nvVFXVideoFrameGeneration.dll"} <= required, required)
        self.assertTrue(required <= set(lock["runtime"]), required - set(lock["runtime"]))

    def test_windows_bundle_deploys_the_runtime_when_configured(self):
        bundle = (ROOT / "CMakeModules/CompleteBundle.cmake").read_text(encoding="utf-8")
        install = (ROOT / "CMakeModules/CompleteBundleWin.cmake.in").read_text(encoding="utf-8")
        self.assertIn("tigerest_validate_nvidia_vfx", bundle)
        self.assertIn("tigerest_deploy_nvidia_vfx", install)
        self.assertIn('EXCLUDE REGEX "/vfg/nvidia/"', install)


if __name__ == "__main__":
    unittest.main()
