#!/usr/bin/env python3
"""Stage the bundled mpv filter runtime before the Mach-O dependency fixup."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from rife.vapoursynth_runtime import inspect_runtime


def stage_runtime(app: Path, brew: Path, runtime_python: Path | None = None) -> None:
    vs_root = brew / "opt/vapoursynth"
    interpreter = runtime_python or vs_root / "libexec/bin/python3"
    if not runtime_python and not interpreter.is_file():
        raise RuntimeError("Bundling requires the current Homebrew VapourSynth Python package")
    if runtime_python:
        info = inspect_runtime(interpreter)
    else:
        info = json.loads(subprocess.check_output([
            str(interpreter), "-I", "-c",
            "import json,sys,vapoursynth; print(json.dumps({"
            "'prefix':sys.base_prefix,'version':f'{sys.version_info.major}.{sys.version_info.minor}',"
            "'pythonVersion':sys.version,'vapoursynthVersion':str(vapoursynth.__version__),"
            "'package':vapoursynth.__path__[0]}))",
        ], text=True))
    prefix = Path(info["prefix"])
    if info['vapoursynthVersion']!='R79':
        raise RuntimeError('This bundle recipe is verified with VapourSynth R79; qualify a new runtime before updating it')
    version = info["version"]
    contents = app / "Contents"
    runtime = contents / "Resources/python"
    stdlib = runtime / "lib" / f"python{version}"
    stdlib.mkdir(parents=True, exist_ok=True)
    # Homebrew removes a Python once nothing it installed needs it. A release
    # can then reuse the relocated Python of a verified bundle (the previous
    # release) instead of a different build of that version.
    reused = os.environ.get("TIGEREST_PYTHON_RUNTIME_SOURCE")
    if reused:
        source = Path(reused) / "Contents"
        recorded = json.loads((source / "Resources/vapoursynth-runtime.json").read_text())
        if recorded["version"] != version or recorded["vapoursynthVersion"] != info["vapoursynthVersion"]:
            raise RuntimeError("The reused bundle has another Python or VapourSynth")
        prefix = source / "Resources/python"
        info["pythonVersion"] = recorded["pythonVersion"]
    # Homebrew's site-packages is an external symlink. Ship only our runtime,
    # never the build machine's installed packages or optional Tk/test modules.
    shutil.copytree(prefix / "lib" / f"python{version}", stdlib,
                    dirs_exist_ok=True, symlinks=True,
                    ignore=shutil.ignore_patterns("site-packages", "__pycache__", "*.pyc",
                                                 "test", "tests", "config-*", "ensurepip", "_tkinter*", "_test*", "idlelib", "tkinter", "turtledemo"))
    package = stdlib / "site-packages/vapoursynth"
    shutil.copytree(info["package"], package, dirs_exist_ok=True, symlinks=True,
                    ignore=shutil.ignore_patterns("plugins", "include", "pkgconfig", "vspipe",
                                                 "__pycache__", "*.pyc"))
    (contents / "Frameworks").mkdir(parents=True, exist_ok=True)
    shutil.copy2(source / "Frameworks/Python" if reused else prefix / "Python", contents / "Frameworks/Python")
    # Homebrew bin/python is a launcher that follows its original framework.
    # Copy the actual interpreter to make PYTHONHOME and relocation effective.
    executable = source / "MacOS/tigerest-python" if reused else prefix / "Resources/Python.app/Contents/MacOS/Python"
    if not executable.is_file():
        raise RuntimeError("Missing standalone framework Python interpreter")
    shutil.copy2(executable, contents / "MacOS/tigerest-python")
    if reused:
        # The reused modules already name their libraries inside the bundle,
        # so the dependency fixup cannot find them; bring the missing ones along.
        for binary in [*stdlib.rglob("*.so"), contents / "Frameworks/Python"]:
            for line in subprocess.check_output(["otool", "-L", str(binary)], text=True).splitlines()[1:]:
                dependency = line.strip().split(" (compatibility")[0]
                name = dependency.removeprefix("@executable_path/../Frameworks/")
                if name != dependency and not (contents / "Frameworks" / name).exists():
                    shutil.copy2(source / "Frameworks" / name, contents / "Frameworks" / name)
    # Retain VapourSynth's adjacent libraries instead of resolving an older
    # Homebrew installation that may also exist on the build machine.
    for binary in list(package.glob("*.dylib")) + list(package.glob("*.so")):
        if binary.suffix == ".dylib":
            subprocess.run(["install_name_tool", "-id", f"@loader_path/{binary.name}", str(binary)], check=True)
        dependencies = subprocess.check_output(["otool", "-L", str(binary)], text=True)
        for line in dependencies.splitlines()[1:]:
            dependency = line.strip().split(" (compatibility")[0]
            adjacent = package / Path(dependency).name
            if adjacent.is_file() and adjacent != binary:
                subprocess.run(["install_name_tool", "-change", dependency,
                                f"@loader_path/{adjacent.name}", str(binary)], check=True)
    wrapper = contents / "MacOS/vapoursynth"
    subprocess.run(['xcrun','clang','-mmacosx-version-min=26.0',
                    '-DTIGEREST_PYTHON_VERSION="'+version+'"',
                    str(Path(__file__).with_name('vapoursynth_launcher.c')),
                    '-o',str(wrapper)],check=True)
    manifest = {
        "pythonHome": "../Resources/python",
        "version": version,
        "pythonVersion": info['pythonVersion'],
        "vapoursynthVersion": info['vapoursynthVersion'],
        "pythonPath": f"../Resources/python/lib/python{version}/site-packages",
        "library": f"../Resources/python/lib/python{version}/site-packages/vapoursynth/libvsscript.dylib",
    }
    (contents / "Resources/vapoursynth-runtime.json").write_text(json.dumps(manifest, indent=2) + "\n")
    python_license = source / "Resources/licenses/Python/LICENSE" if reused else brew / f"opt/python@{version}/LICENSE"
    for name, license_file in [("Python", python_license),
                               ("VapourSynth", Path(info['license']) if runtime_python else vs_root / "COPYING.LESSER"),
                               ("zimg", brew / "opt/zimg/COPYING")]:
        destination = contents / "Resources/licenses" / name
        destination.mkdir(parents=True, exist_ok=True)
        shutil.copy2(license_file, destination / license_file.name)
    print(f"Staged Python {info['pythonVersion'].split()[0]}{' from ' + reused if reused else ''} and VapourSynth in {app}")


if __name__ == "__main__":
    stage_runtime(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]) if len(sys.argv)>3 and sys.argv[3] else None)
