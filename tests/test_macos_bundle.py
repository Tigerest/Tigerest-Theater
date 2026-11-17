#!/usr/bin/env python3
"""Check runtime-loaded Vulkan dependencies in an installed macOS bundle.

Run after bundling: python3 tests/test_macos_bundle.py 'build/output/Tigerest Theater.app'
"""

import json
import hashlib
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys
import tempfile


def verify_vulkan_driver(app: Path) -> None:
    app = app.resolve()
    manifest = app / "Contents/Resources/vulkan/icd.d/MoltenVK_icd.json"
    assert manifest.is_file(), "Missing bundled MoltenVK driver manifest"
    icd = json.loads(manifest.read_text())["ICD"]
    relative = Path(icd["library_path"])
    assert not relative.is_absolute(), "Driver manifest points outside the portable bundle"
    library = (manifest.parent / relative).resolve()
    assert library.is_relative_to(app), "Driver manifest escapes the application bundle"
    assert library.is_file(), "Bundled Vulkan driver is missing"
    assert icd["is_portability_driver"] is True
    executable = app / "Contents/MacOS/Tigerest Theater"
    app_archs = set(subprocess.check_output(["lipo", "-archs", str(executable)], text=True).split())
    driver_archs = set(subprocess.check_output(["lipo", "-archs", str(library)], text=True).split())
    assert app_archs <= driver_archs, "Vulkan driver does not support the application architecture"


def verify_vapoursynth_runtime(app: Path) -> None:
    app = app.resolve()
    manifest_path = app / "Contents/Resources/vapoursynth-runtime.json"
    assert manifest_path.is_file(), "Missing bundled VapourSynth/Python runtime"
    manifest = json.loads(manifest_path.read_text())
    binary_dir = app / "Contents/MacOS"
    paths = {key: (binary_dir / manifest[key]).resolve()
             for key in ("library", "pythonHome", "pythonPath")}
    assert all(p.exists() and p.is_relative_to(app) for p in paths.values())
    environment = {k: v for k, v in os.environ.items()
                   if not k.startswith(("PYTHON", "DYLD_", "VSSCRIPT"))}
    environment.update(PATH="/usr/bin:/bin:/usr/sbin:/sbin",
                       PYTHONHOME=str(paths["pythonHome"]),
                       PYTHONPATH=str(paths["pythonPath"]), PYTHONNOUSERSITE="1", PYTHONDONTWRITEBYTECODE="1")
    with tempfile.TemporaryDirectory(prefix="tigerest-vs-check-") as fresh_config:
        environment["XDG_CONFIG_HOME"] = fresh_config
        subprocess.run([str(binary_dir / "vapoursynth"), "config"], env=environment,
                       check=True, capture_output=True, text=True, timeout=30)
        assert (Path(fresh_config) / "vapoursynth/vapoursynth.toml").is_file()
        # Importing the extension must load only the shipped Python/VS/zimg.
        probe = """
import ctypes,json,sys,vapoursynth
dyld=ctypes.CDLL(None)
dyld._dyld_image_count.restype=ctypes.c_uint32
dyld._dyld_get_image_name.restype=ctypes.c_char_p
dyld._dyld_get_image_name.argtypes=[ctypes.c_uint32]
print(json.dumps({'prefix':sys.prefix,'runtime':vapoursynth.get_vsscript(),
'images':[dyld._dyld_get_image_name(i).decode() for i in range(dyld._dyld_image_count())]}))
"""
        result = json.loads(subprocess.check_output(
            [str(binary_dir / "tigerest-python"), "-c", probe], env=environment,
            text=True, timeout=30))
        assert Path(result["prefix"]).resolve() == paths["pythonHome"]
        assert Path(result["runtime"]).resolve() == paths["library"]
        assert not any(p.startswith(("/opt/homebrew/", "/usr/local/")) for p in result["images"]), result


def verify_rife_models(app: Path) -> None:
    app=app.resolve()
    root=app/'Contents/Resources/rife'
    manifest=json.loads((root/'model/manifest.json').read_text())
    assert manifest['model']=='rife-4.25-lite'
    assert manifest['width']==1920 and manifest['height']==1080
    assert manifest['grid_scale']==0.5
    assert manifest['pipeline']=='ane-encoder-refine-gpu-motion'
    assert manifest['runtime_pipeline']=='split-coarse-metal'
    pinned=json.loads((app/'Contents/Resources/licenses/Practical-RIFE/model_source.json').read_text())
    assert manifest['revision']==pinned['revision']
    assert manifest['weights_sha256']==pinned['files']['train_log/flownet.pkl']
    for relative,digest in manifest['compiled_sha256'].items():
        path=(root/'model'/relative).resolve()
        assert path.is_relative_to(root.resolve()),'Escaping compiled model path'
        assert hashlib.sha256(path.read_bytes()).hexdigest()==digest,f'Changed compiled model: {relative}'
    for name in ('Encoder','Stage0','Stage1','Stage2','Stage3','Refine'):
        compiled=root/'model'/f'{name}.mlmodelc'
        assert compiled.is_dir(),f'Missing compiled {name} model'
        assert any(compiled.iterdir()),f'Empty compiled {name} model'
    assert not (root/'model/Coarse.mlmodelc').exists(),'Obsolete coarse model must not be shipped'
    for file in (app/'Contents/Frameworks/libtigerest-rife.dylib',
                 app/'Contents/Frameworks/tigerest-rife-vs.dylib',root/'interpolate.vpy'):
        assert file.is_file(),f'Missing RIFE component: {file}'
    for file in root.rglob('*'):
        assert file.resolve().is_relative_to(app),f'Escaping RIFE path: {file}'
    assert not list(root.rglob('*.mlpackage')),'Runtime must not compile model packages'


def macho_files(app):
    magic={b'\xcf\xfa\xed\xfe',b'\xca\xfe\xba\xbe',b'\xfe\xed\xfa\xcf',b'\xbe\xba\xfe\xca'}
    for file in app.rglob('*'):
        if file.is_file() and not file.is_symlink():
            with file.open('rb') as source: header=source.read(4)
            if header in magic:yield file


def verify_dependencies(app: Path) -> None:
    app=app.resolve()
    frameworks=app/'Contents/Frameworks'
    for link in app.rglob('*'):
        if link.is_symlink():assert link.exists() and link.resolve().is_relative_to(app),f'Broken/escaping symlink: {link}'
    for binary in macho_files(app):
        output=subprocess.check_output(['otool','-L',str(binary)],text=True)
        for line in output.splitlines()[1:]:
            if ' (compatibility' not in line:continue # universal binaries repeat architecture headers
            dependency=line.strip().split(' (compatibility')[0]
            if dependency.startswith(('/System/Library/','/usr/lib/')):continue
            if dependency.startswith('@rpath/'):
                target=frameworks/dependency.removeprefix('@rpath/')
            elif dependency.startswith('@executable_path/'):
                # QtWebEngineProcess has its own Frameworks symlink.
                executable=binary.parent if binary.name=='QtWebEngineProcess' else app/'Contents/MacOS'
                target=executable/dependency.removeprefix('@executable_path/')
            elif dependency.startswith('@loader_path/'):
                target=binary.parent/dependency.removeprefix('@loader_path/')
            else:raise AssertionError(f'External runtime dependency: {binary}: {dependency}')
            assert target.resolve().is_relative_to(app),f'Escaping library: {binary}: {target}'
            assert target.exists(),f'Missing library: {binary}: {target}'


def required_macos(load_commands):
    """Return every minimum macOS recorded in `otool -l` output."""
    versions=[]
    # Field order differs between otool versions (LLVM prints sdk before minos).
    for block in re.split(r'^Load command \d+$',load_commands,flags=re.M)[1:]:
        fields=dict(line.split(None,1) for line in block.splitlines() if len(line.split(None,1))==2)
        if fields.get('cmd')=='LC_BUILD_VERSION' and fields.get('platform','').lower() in ('1','macos'):
            versions.append(fields['minos'])
        elif fields.get('cmd')=='LC_VERSION_MIN_MACOSX':
            versions.append(fields['version'])
    return versions


def macos_version(text):
    return tuple(int(part) for part in (text.split('.')+['0','0'])[:3])


def verify_minimum_macos(app: Path) -> None:
    # dyld loads a library built for a newer macOS and then aborts on the first
    # libc++/system symbol that older release lacks, before any app code runs.
    app=app.resolve()
    with (app/'Contents/Info.plist').open('rb') as source:
        info=plistlib.load(source)
    declared=info['LSMinimumSystemVersion']
    executable=app/'Contents/MacOS'/info['CFBundleExecutable']
    newer=set()
    for binary in macho_files(app):
        required=required_macos(subprocess.check_output(['otool','-l',str(binary)],text=True))
        if binary==executable:assert required,f'Cannot read the minimum macOS of {binary}'
        newer.update(f'{binary.relative_to(app)} (macOS {version})' for version in required
                     if macos_version(version)>macos_version(declared))
    assert not newer,(f'Bundled code needs a newer macOS than LSMinimumSystemVersion {declared}; '
                      f'build on macOS {declared} so Homebrew bottles match: '+', '.join(sorted(newer)))


def verify_patched_webengine(app: Path) -> None:
    # The stock Qt 6.9.3 engine runs the whole web UI on a 60 Hz timer and
    # lacks the small-image decode patch (dev/macos/qt/README.md). Releases and
    # CI install the arm64-only patched build with use_patched_webengine.py.
    script=Path(__file__).resolve().parents[1]/'dev/macos/use_patched_webengine.py'
    expected=re.search(r"^PATCHED_UUID = '([0-9A-F-]+)'$",script.read_text(),re.M).group(1)
    core=app.resolve()/'Contents/Frameworks/QtWebEngineCore.framework/Versions/A/QtWebEngineCore'
    found=re.findall(r'^\s*uuid ([0-9A-F-]+)$',subprocess.check_output(['otool','-l',str(core)],text=True),re.M)
    if expected in found:return
    assert os.environ.get('TIGEREST_ALLOW_STOCK_WEBENGINE')=='1',(
        f'QtWebEngineCore {found} is not the patched engine {expected}; install it with '
        'dev/macos/use_patched_webengine.py, or set TIGEREST_ALLOW_STOCK_WEBENGINE=1 for a local non-release bundle')
    print('warning: stock Qt WebEngine allowed by TIGEREST_ALLOW_STOCK_WEBENGINE; the web UI is limited to 60 Hz',
          file=sys.stderr)


if __name__ == "__main__":
    verify_minimum_macos(Path(sys.argv[1]))
    verify_vulkan_driver(Path(sys.argv[1]))
    verify_vapoursynth_runtime(Path(sys.argv[1]))
    archs=subprocess.check_output(['lipo','-archs',str(Path(sys.argv[1])/'Contents/MacOS/Tigerest Theater')],text=True)
    if 'arm64' in archs:
        verify_rife_models(Path(sys.argv[1]))
        verify_patched_webengine(Path(sys.argv[1]))
    verify_dependencies(Path(sys.argv[1]))
    print("PASS: bundled code within LSMinimumSystemVersion, portable MoltenVK/Python/VapourSynth, "
          "verified RIFE models and patched WebEngine on arm64, closed runtime dependencies")
