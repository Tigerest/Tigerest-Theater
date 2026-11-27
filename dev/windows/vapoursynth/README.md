# VapourSynth runtime (bundled with the Windows player)

VapourSynth filters run inside mpv on a private Python and VapourSynth that the
player activates once per process, before mpv is created
(`src/player/interpolation/windows/RifeVSScriptRuntime.cpp`). Since 3.1.0 the
Windows package ships one in `vapoursynth` next to the player, so NVIDIA frame
generation (VFG) works without the RIFE extension:

- The startup gate uses the RIFE extension's runtime when the extension is
  verified and its probe succeeds; RIFE itself still needs the extension.
- Otherwise it activates `<app>/vapoursynth`. A process keeps the runtime it
  started with; installing the extension takes effect on restart.
- VFG passes the activated root to `interpolate_vfg.vpy` as `runtime_path`.
  Without the extension's probe, the CUDA compute capability comes from the
  NVIDIA driver (`rife::cudaComputeCapability`).

RTX Video Super Resolution and RTX Video HDR do not use VapourSynth: they are
mpv's `d3d11vpp` filter and never needed the extension.

The runtime is the extension's `python` directory without TensorRT, models or
the RIFE scripts: CPython's embeddable package and the VapourSynth portable
wheel that `dev/windows/rife/runtime-lock.json` pins, unmodified, plus a
`python313._pth` of its own (`python313.zip`, `.`, `Lib/site-packages`).
`runtime-lock.json` pins every file (59 files, about 32 MB).

Prepare it before configuring a release build:

```powershell
python dev/windows/vapoursynth/prepare_vapoursynth_runtime.py --output D:/CodexDeps/TigerestTheater/vapoursynth-R79
$env:TIGEREST_VAPOURSYNTH_RUNTIME_DIR = 'D:/CodexDeps/TigerestTheater/vapoursynth-R79'
# Or pass -DTIGEREST_VAPOURSYNTH_RUNTIME_DIR=... to CMake.
```

Without `--from-runtime` the script downloads the two archives into
`build/rife/downloads` (or `--archives DIR`; `--offline` uses only what is
there) and checks them against the RIFE lock. `--from-runtime RIFE_RUNTIME`
copies the `python` directory of a prepared RIFE extension runtime instead.
Either way the result must match the lock file for file; an existing output is
verified and a mismatching one is rejected.

Configure and install check every file's size and SHA-256 and reject extra
files. Install replaces `vapoursynth` as a whole, copies Python's license,
VapourSynth's LGPL text and the lock to `licenses/vapoursynth`, and keeps the
runtime out of code signing: Python's files keep the Python Software
Foundation's signatures and VapourSynth's stay unsigned, as published. Without
`TIGEREST_VAPOURSYNTH_RUNTIME_DIR` the package has no runtime and VFG asks for
the RIFE extension, as in 3.0.0.

When the RIFE lock moves to another Python or VapourSynth, prepare a new
directory from the new archives and record it:

```powershell
python dev/windows/vapoursynth/prepare_vapoursynth_runtime.py --output D:/CodexDeps/TigerestTheater/vapoursynth-NEW --write-lock
```

Update `PTH` and `LICENSES` in the script first if the Python minor version or
the wheel's `dist-info` name changes.
