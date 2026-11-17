# NVIDIA Video Effects runtime (frame generation)

NVIDIA frame generation (VFG) runs as the VapourSynth filter `tigerest-vfg-vs`
on the RIFE extension's private VapourSynth runtime. The filter loads NVIDIA's
Video Effects runtime from `vfg\nvidia` next to the player. The Windows package
ships that runtime unmodified, pinned by `runtime-lock.json`.

Prepare the runtime before configuring a release build:

```powershell
python dev/windows/nvidia-vfx/prepare_nvidia_vfx_runtime.py --output D:/CodexDeps/TigerestTheater/nvidia-vfx-0.2.0.0
$env:TIGEREST_NVIDIA_VFX_RUNTIME_DIR = 'D:/CodexDeps/TigerestTheater/nvidia-vfx-0.2.0.0'
# Or pass -DTIGEREST_NVIDIA_VFX_RUNTIME_DIR=... to CMake.
```

Without `--wheel` the script downloads NVIDIA's wheel (436 MB) into
`build/nvidia-vfx-downloads` and checks its published SHA-256. `--wheel PATH
--offline` uses a wheel you already have. `--from-dir DIR --licenses-from DIR`
takes loose copies of the same files instead; each file must match the lock.
Existing output is verified and a mismatching output is rejected.

`runtime-lock.json` records the wheel's address, size and SHA-256 and, for each
shipped file, its member path, size and SHA-256 from the wheel's `RECORD`.
Only the five DLLs frame generation loads are shipped; the wheel's super
resolution, TrueHDR and NPP DLLs are not.

The variable is optional. When it is set, configure validates the runtime and
install copies it to `vfg/nvidia`, and the license files, lock and NOTICE to
`licenses/nvidia-vfx`, checking every copy. When it is not set, the package has
no frame generation runtime and the player hides the VFG settings. A release
package must have it, so the release check compares `vfg/nvidia` in the
package with the lock.

The runtime is NVIDIA proprietary software under the license files listed in
the lock (NVIDIA Software License Agreement and product-specific terms), which
the package ships next to it. Frame generation needs a GeForce RTX 40 or 50
series card (CUDA compute capability 8.9 or newer) with driver 570.65 or newer;
the player checks the card before it adds the filter.

Developer overrides go in `vfg-test.json` in the global data directory (keys
`plugin`, `script`, `runtime`, `debug_log`). The prototype and its notes are in
`dev/windows/vfg`.
