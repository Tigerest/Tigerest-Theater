"""Exercise the bundled VapourSynth runtime's preparation, check and deployment."""
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
CMAKE = os.environ.get("CMAKE_COMMAND") or shutil.which("cmake")
LOCK = ROOT / "dev/windows/vapoursynth/runtime-lock.json"
PTH = "python313.zip\n.\nLib/site-packages\n"
LICENSES = {"python": "python/LICENSE.txt",
            "vapoursynth": "python/Lib/site-packages/vapoursynth-79.dist-info/licenses/COPYING.LESSER"}
PYTHON = {"python.exe": b"python", "python3.dll": b"python3", "python313.dll": b"python313",
          "python313.zip": b"stdlib", "LICENSE.txt": b"psf license"}
WHEEL = {"vapoursynth/vsscript.dll": b"vsscript", "vapoursynth/libvapoursynth.dll": b"core",
         "vapoursynth-79.dist-info/licenses/COPYING.LESSER": b"lgpl"}
# The fixture runtime: CPython's files, the wheel's files and the _pth.
RUNTIME = {**{"python/" + name: data for name, data in PYTHON.items()},
           **{"python/Lib/site-packages/" + name: data for name, data in WHEEL.items()},
           "python/python313._pth": PTH.encode()}


def entry(data):
    return {"size": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def fixture_lock():
    return {"schemaVersion": 1, "runtime": "vapoursynth", "licenses": LICENSES,
            "files": {name: entry(data) for name, data in sorted(RUNTIME.items())}}


def write_tree(directory, files):
    for name, data in files.items():
        path = directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


class VapourSynthDeployment(unittest.TestCase):
    def run_cmake(self, root, runtime, lock, *, deploy=True):
        lock_path = root / "lock.json"
        lock_path.write_text(json.dumps(lock), encoding="utf-8")
        output = root / "bundle"
        script = root / "run.cmake"
        call = (f'tigerest_deploy_vapoursynth("{runtime.as_posix()}" "{lock_path.as_posix()}" "{output.as_posix()}")'
                if deploy else f'tigerest_validate_vapoursynth("{runtime.as_posix()}" "{lock_path.as_posix()}")')
        script.write_text(f'include("{ROOT.as_posix()}/CMakeModules/DeployWindowsVapourSynth.cmake")\n{call}\n', encoding="utf-8")
        result = subprocess.run([CMAKE, "-P", str(script)], capture_output=True, encoding="utf-8", errors="replace")
        files = {p.relative_to(output).as_posix(): p.read_bytes() for p in output.rglob("*") if p.is_file()}
        return result, files

    def test_exact_runtime_licenses_and_lock_are_deployed(self):
        with tempfile.TemporaryDirectory(prefix="tigerest-vs-deploy-") as temporary:
            root = Path(temporary)
            runtime = root / "中文 VapourSynth runtime"
            write_tree(runtime, RUNTIME)
            # A runtime an earlier version left must not survive next to this one.
            write_tree(root / "bundle", {"vapoursynth/python/stale.pyd": b"old", "keep.txt": b"keep"})
            result, files = self.run_cmake(root, runtime, fixture_lock())
            self.assertEqual(result.returncode, 0, result.stderr)
            for name, data in RUNTIME.items():
                self.assertEqual(files["vapoursynth/" + name], data)
            self.assertEqual(files["licenses/vapoursynth/python-LICENSE.txt"], b"psf license")
            self.assertEqual(files["licenses/vapoursynth/vapoursynth-COPYING.LESSER"], b"lgpl")
            self.assertEqual(json.loads(files["licenses/vapoursynth/runtime-lock.json"]), fixture_lock())
            self.assertNotIn("vapoursynth/python/stale.pyd", files)
            self.assertEqual(files["keep.txt"], b"keep")
            self.assertEqual(len(files), len(RUNTIME) + 3 + 1)

    def test_missing_corrupt_or_extra_files_fail_before_deploying_anything(self):
        cases = [("missing", name) for name in RUNTIME] + [("corrupt", name) for name in RUNTIME] + [("extra", "python/sitecustomize.py")]
        for mode, name in cases:
            with self.subTest(mode=mode, file=name), tempfile.TemporaryDirectory(prefix="tigerest-vs-deploy-") as temporary:
                root = Path(temporary)
                files = dict(RUNTIME)
                if mode == "missing":
                    del files[name]
                else:
                    files[name] = b"wrong"
                write_tree(root / "runtime", files)
                result, deployed = self.run_cmake(root, root / "runtime", fixture_lock())
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("VapourSynth runtime", result.stderr)
                self.assertEqual(deployed, {})

    def test_missing_directory_names_the_variable(self):
        with tempfile.TemporaryDirectory(prefix="tigerest-vs-deploy-") as temporary:
            root = Path(temporary)
            result, _ = self.run_cmake(root, root / "absent", fixture_lock(), deploy=False)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("TIGEREST_VAPOURSYNTH_RUNTIME_DIR", result.stderr)

    def prepare(self, root, lock, *arguments, rife_lock=None):
        # The script reads its lock next to itself and the RIFE helpers and
        # lock from ../rife: run a copy of both beside fixture locks.
        tool = root / "tool"
        if not tool.exists():
            shutil.copytree(ROOT / "dev/windows/rife", tool / "rife", ignore=shutil.ignore_patterns("*.json", "__pycache__"))
            (tool / "vapoursynth").mkdir()
            shutil.copyfile(ROOT / "dev/windows/vapoursynth/prepare_vapoursynth_runtime.py", tool / "vapoursynth/prepare.py")
        (tool / "vapoursynth/runtime-lock.json").write_text(json.dumps(lock), encoding="utf-8")
        (tool / "rife/runtime-lock.json").write_text(json.dumps(rife_lock or {"archives": []}), encoding="utf-8")
        return subprocess.run([sys.executable, "-I", "-B", str(tool / "vapoursynth/prepare.py"), "--output", str(root / "out"), *arguments],
                              capture_output=True, encoding="utf-8", errors="replace")

    def staged(self, root):
        return {p.relative_to(root / "out").as_posix(): p.read_bytes() for p in (root / "out").rglob("*") if p.is_file()}

    def test_preparation_from_the_official_archives(self):
        with tempfile.TemporaryDirectory(prefix="tigerest-vs-prepare-") as temporary:
            root = Path(temporary)
            archives = root / "archives"
            archives.mkdir()
            with zipfile.ZipFile(archives / "python-embed.zip", "w") as archive:
                for name, data in PYTHON.items():
                    archive.writestr(name, data)
                archive.writestr("python313._pth", "python313.zip\n.\n")
            wheel = io.BytesIO()
            with zipfile.ZipFile(wheel, "w") as archive:
                for name, data in WHEEL.items():
                    archive.writestr(name, data)
                archive.writestr("vapoursynth/vsscript.pdb", b"debug symbols")
            with zipfile.ZipFile(archives / "VapourSynth-Portable.zip", "w") as archive:
                archive.writestr("wheel/vapoursynth-79-cp313-abi3-win_amd64.whl", wheel.getvalue())
                archive.writestr("vspipe.exe", b"not shipped")
            rife_lock = {"archives": [
                {"id": "python", "file": "python-embed.zip", "url": "https://invalid.example/python-embed.zip",
                 **entry((archives / "python-embed.zip").read_bytes())},
                {"id": "vapoursynth", "file": "VapourSynth-Portable.zip", "url": "https://invalid.example/vs.zip",
                 **entry((archives / "VapourSynth-Portable.zip").read_bytes())}]}
            result = self.prepare(root, fixture_lock(), "--archives", str(archives), "--offline", rife_lock=rife_lock)
            self.assertEqual(result.returncode, 0, result.stderr)
            # The embeddable package's own _pth is replaced; debug symbols and
            # everything outside the wheel stay out.
            self.assertEqual(self.staged(root), RUNTIME)
            # Existing output is verified, not staged again, and a changed file is rejected.
            again = self.prepare(root, fixture_lock(), "--archives", str(archives), "--offline", rife_lock=rife_lock)
            self.assertEqual(again.returncode, 0, again.stderr)
            self.assertIn("verified", again.stdout)
            (root / "out/python/python313._pth").write_text(PTH + "../scripts\n", encoding="utf-8")
            rejected = self.prepare(root, fixture_lock(), "--archives", str(archives), "--offline", rife_lock=rife_lock)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("python/python313._pth", rejected.stderr)

    def test_preparation_rejects_a_changed_archive_without_staging(self):
        with tempfile.TemporaryDirectory(prefix="tigerest-vs-prepare-") as temporary:
            root = Path(temporary)
            archives = root / "archives"
            archives.mkdir()
            (archives / "python-embed.zip").write_bytes(b"tampered")
            rife_lock = {"archives": [
                {"id": "python", "file": "python-embed.zip", "url": "https://invalid.example/python-embed.zip", **entry(b"genuine!")},
                {"id": "vapoursynth", "file": "vs.zip", "url": "https://invalid.example/vs.zip", **entry(b"vs")}]}
            result = self.prepare(root, fixture_lock(), "--archives", str(archives), "--offline", rife_lock=rife_lock)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("python-embed.zip", result.stderr)
            self.assertFalse((root / "out").exists())

    def test_preparation_from_a_rife_runtime_drops_its_scripts_path(self):
        for extra in (None, "python/Lib/site-packages/vsmlrt.py"):
            with self.subTest(extra=extra), tempfile.TemporaryDirectory(prefix="tigerest-vs-prepare-") as temporary:
                root = Path(temporary)
                rife = dict(RUNTIME)
                rife["python/python313._pth"] = (PTH + "../scripts\n").encode()
                if extra:
                    rife[extra] = b"a RIFE module"
                rife["plugins/vstrt.dll"] = b"TensorRT"
                write_tree(root / "rife-runtime", rife)
                result = self.prepare(root, fixture_lock(), "--from-runtime", str(root / "rife-runtime"))
                if extra:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("vsmlrt.py", result.stderr)
                    self.assertFalse((root / "out").exists())
                else:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(self.staged(root), RUNTIME)

    def test_write_lock_records_a_new_runtime(self):
        with tempfile.TemporaryDirectory(prefix="tigerest-vs-prepare-") as temporary:
            root = Path(temporary)
            write_tree(root / "rife-runtime", RUNTIME)
            old = fixture_lock()
            old["files"] = {"python/python.exe": entry(b"an older python")}
            rife_lock = {"archives": [], "versions": {"python": "3.13.99", "vapoursynth": "R80", "tensorrt": "x"}}
            result = self.prepare(root, old, "--from-runtime", str(root / "rife-runtime"), "--write-lock", rife_lock=rife_lock)
            self.assertEqual(result.returncode, 0, result.stderr)
            written = json.loads((root / "tool/vapoursynth/runtime-lock.json").read_text(encoding="utf-8"))
            self.assertEqual(written["files"], fixture_lock()["files"])
            self.assertEqual(written["versions"], {"python": "3.13.99", "vapoursynth": "R80"})
            self.assertEqual(written["licenses"], LICENSES)

    def test_checked_in_lock_matches_what_the_player_loads(self):
        lock = json.loads(LOCK.read_text(encoding="utf-8"))
        self.assertEqual(lock["schemaVersion"], 1)
        rife = json.loads((ROOT / "dev/windows/rife/runtime-lock.json").read_text(encoding="utf-8"))
        self.assertEqual(lock["versions"], {key: rife["versions"][key] for key in ("python", "vapoursynth")})
        for name, item in lock["files"].items():
            self.assertTrue(name.startswith("python/"), name)
            self.assertRegex(item["sha256"], r"^[0-9a-f]{64}$", name)
        for relative in LICENSES.values():
            self.assertIn(relative, lock["files"])
        self.assertEqual(lock["licenses"], LICENSES)
        # The four DLLs and the isolated configuration activateVSScriptRuntime requires.
        for name in ("python/python3.dll", "python/python313.dll", "python/python.exe", "python/python313._pth",
                     "python/Lib/site-packages/vapoursynth/vsscript.dll",
                     "python/Lib/site-packages/vapoursynth/libvapoursynth.dll"):
            self.assertIn(name, lock["files"])
        self.assertEqual(lock["files"]["python/python313._pth"], entry(PTH.encode()))

    def test_windows_bundle_deploys_the_runtime_when_configured(self):
        bundle = (ROOT / "CMakeModules/CompleteBundle.cmake").read_text(encoding="utf-8")
        install = (ROOT / "CMakeModules/CompleteBundleWin.cmake.in").read_text(encoding="utf-8")
        self.assertIn("tigerest_validate_vapoursynth", bundle)
        self.assertIn("tigerest_deploy_vapoursynth", install)
        self.assertIn('EXCLUDE REGEX "/vapoursynth/"', install)
        player = (ROOT / "src/player/PlayerComponent.cpp").read_text(encoding="utf-8")
        self.assertIn('applicationDirPath()+QStringLiteral("/vapoursynth")', player)
        self.assertIn('{QStringLiteral("runtime_path"), m_vapoursynthRoot}', player)


if __name__ == "__main__":
    unittest.main()
