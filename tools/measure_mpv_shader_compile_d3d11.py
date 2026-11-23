#!/usr/bin/env python3
"""Measure how long each bundled shader takes to compile the first time on
Windows, where the client renders with mpv gpu-next on Direct3D 11.

libplacebo turns every pass into GLSL -> SPIR-V -> HLSL -> DXBC. The last step
(FXC, D3DCompile) runs on the CPU and takes up to minutes for the large
unrolled CNN shaders; the picture stops until it is done. Each compiled pass is
then kept in mpv's shader cache, so this is a one-time cost per machine and
libmpv build.

Loads the client's own libmpv-2.dll (not mpv.exe, so the numbers come from the
same libplacebo build and patches the client ships) and plays a synthetic
4:2:0 test pattern in a 1920x1080 window, sized for each shader's trigger like
tools/measure_mpv_shaders.py. For every shader it records the seconds from
file-loaded until the chain's passes have rendered frames, first with a cache
that holds only the pipeline without shaders (cold), then again with the cache
that run filled (warm). The difference is the first-compile time.

Writes resources/mpvconf/shader-compile-d3d11.json; run
tools/generate_mpv_shader_catalog.py afterwards to fold it into the catalog.
The seconds are FXC time on the CPU that ran this: slower CPUs take longer.
Opens a window per run and takes about 15 minutes on a fast desktop CPU.

    python tools/measure_mpv_shader_compile_d3d11.py [--dll build/output/libmpv-2.dll] [--only ArtCNN]
"""
import argparse
import ctypes
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SHADERS = ROOT / "resources/mpv/shaders"
OUTPUT = ROOT / "resources/mpvconf/shader-compile-d3d11.json"
SIZES = {"up": "1066x600", "down": "3840x2160"}
LIMIT_SECONDS = 420

# Quits once every pass of the chain has rendered three frames (a pass whose
# shader did not compile is missing from the list instead).
FIRST_FRAMES_LUA = r"""
local utils = require('mp.utils')
local out = mp.get_opt('compile-out')
local limit = tonumber(mp.get_opt('compile-limit'))
mp.register_event('file-loaded', function()
  local started = mp.get_time()
  local timer
  timer = mp.add_periodic_timer(0.05, function()
    local fresh = (mp.get_property_native('vo-passes') or {}).fresh or {}
    local least, descs = nil, {}
    for _, pass in ipairs(fresh) do
      least = math.min(least or pass.count or 0, pass.count or 0)
      descs[#descs + 1] = pass.desc
    end
    local waited = mp.get_time() - started
    if (#fresh > 0 and (least or 0) >= 3) or waited > limit then
      timer:kill()
      local f = io.open(out, 'w')
      f:write(utils.format_json({seconds = waited, descs = descs, timed_out = waited > limit}))
      f:close()
      mp.command('quit')
    end
  end)
end)
"""


class Event(ctypes.Structure):
    _fields_ = [("event_id", ctypes.c_int), ("error", ctypes.c_int),
                ("reply_userdata", ctypes.c_uint64), ("data", ctypes.c_void_p)]


def child(dll, work, cache, shader, size):
    """One playback in this process; prints one JSON line."""
    # Keep the display awake (a sleeping monitor stalls presentation) and be
    # per-monitor DPI aware like the client, so the window is 1920x1080 pixels.
    ctypes.windll.kernel32.SetThreadExecutionState(0x80000000 | 0x00000002 | 0x00000001)
    ctypes.windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    work = Path(work)
    work.mkdir(parents=True, exist_ok=True)
    lua, out, log = work / "first-frames.lua", work / "result.json", work / "mpv.log"
    lua.write_text(FIRST_FRAMES_LUA, encoding="utf-8")
    for path in (out, log):
        path.unlink(missing_ok=True)
    os.add_dll_directory(str(Path(dll).parent))
    mpv = ctypes.CDLL(dll)
    mpv.mpv_create.restype = ctypes.c_void_p
    mpv.mpv_set_option_string.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p]
    mpv.mpv_initialize.argtypes = [ctypes.c_void_p]
    mpv.mpv_command.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_char_p)]
    mpv.mpv_wait_event.argtypes = [ctypes.c_void_p, ctypes.c_double]
    mpv.mpv_wait_event.restype = ctypes.POINTER(Event)
    mpv.mpv_terminate_destroy.argtypes = [ctypes.c_void_p]
    handle = mpv.mpv_create()
    options = {
        "config": "no", "load-scripts": "no", "terminal": "no", "input-default-bindings": "no",
        "vo": "gpu-next", "gpu-api": "d3d11", "hwdec": "no", "ao": "null", "geometry": "1920x1080",
        "hidpi-window-scale": "no", "keepaspect-window": "no", "force-window": "immediate", "ontop": "yes",
        "profile": "high-quality", "osd-level": "0", "scripts": str(lua), "length": "900",
        "log-file": str(log), "gpu-shader-cache": "yes", "gpu-shader-cache-dir": str(cache),
        "script-opts": f"compile-out={out.as_posix()},compile-limit={LIMIT_SECONDS}",
    }
    if shader:
        options["glsl-shaders"] = shader
    for key, value in options.items():
        if mpv.mpv_set_option_string(handle, key.encode(), value.encode("utf-8")) < 0:
            print(json.dumps({"error": "option " + key}))
            return
    if mpv.mpv_initialize(handle) < 0:
        print(json.dumps({"error": "mpv_initialize failed"}))
        return
    url = f"av://lavfi:testsrc2=size={size}:rate=24,format=yuv420p"
    mpv.mpv_command(handle, (ctypes.c_char_p * 3)(b"loadfile", url.encode(), None))
    deadline = time.time() + LIMIT_SECONDS + 60
    while time.time() < deadline:
        if mpv.mpv_wait_event(handle, 1.0).contents.event_id == 1:  # MPV_EVENT_SHUTDOWN
            break
    mpv.mpv_terminate_destroy(handle)
    result = json.loads(out.read_text(encoding="utf-8")) if out.exists() else {"error": "no result"}
    text = log.read_text(encoding="utf-8", errors="replace") if log.exists() else ""
    result["errors"] = [line.split("] ", 1)[-1][:200] for line in text.splitlines()
                        if re.search(r"\]\[(e|f)\]\[", line)][:8]
    versions = re.findall(r"\[cplayer\] (mpv v\S+|libplacebo version: \S+)", text)
    result["versions"] = list(dict.fromkeys(versions))
    print(json.dumps(result, ensure_ascii=False))


def run(dll, work, cache, shader, size):
    args = [sys.executable, __file__, "--child", dll, str(work), str(cache), shader or "", size]
    try:
        done = subprocess.run(args, capture_output=True, text=True, timeout=LIMIT_SECONDS + 120)
        return json.loads(done.stdout.strip().splitlines()[-1])
    except Exception as error:  # noqa: BLE001 - one broken run must not end the sweep
        return {"error": repr(error)}


def cpu_name():
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as key:
            return winreg.QueryValueEx(key, "ProcessorNameString")[0].strip()
    except OSError:
        return platform.processor()


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--child":
        return child(*sys.argv[2:7])
    parser = argparse.ArgumentParser()
    parser.add_argument("--dll", default=str(ROOT / "build/output/libmpv-2.dll"))
    parser.add_argument("--only", default="", help="re-measure only shaders whose path starts with this")
    args = parser.parse_args()
    dll = str(Path(args.dll).resolve())
    catalog = json.loads((ROOT / "resources/mpvconf/shaders.json").read_text(encoding="utf-8"))
    previous = json.loads(OUTPUT.read_text(encoding="utf-8")) if OUTPUT.exists() and args.only else {}
    results, failed = previous.get("results", {}), previous.get("failed", {})
    versions = []
    with tempfile.TemporaryDirectory(prefix="tigerest-compile-") as folder:
        folder = Path(folder)
        base, work = folder / "base-cache", folder / "work"
        # The pipeline without shaders, at both sizes, so a shader's cold run
        # compiles only what that shader adds.
        base_descs = {}
        for size in SIZES.values():
            baseline = run(dll, work, base, None, size)
            versions = baseline.get("versions") or versions
            print("baseline", size, round(baseline.get("seconds", -1), 2), baseline.get("error", ""), flush=True)
            if baseline.get("error") or baseline.get("errors"):
                print("the pipeline without shaders does not render:", baseline, file=sys.stderr)
                return 1
            base_descs[size] = set(baseline.get("descs", []))
        for shader in catalog["shaders"]:
            path = shader["path"]
            if args.only and not path.startswith(args.only):
                continue
            size = SIZES["down" if shader["trigger"] == "只在缩小时运行" else "up"]
            cache = folder / "cache"
            shutil.rmtree(cache, ignore_errors=True)
            shutil.copytree(base, cache)
            cold = run(dll, work, cache, str(SHADERS / path), size)
            warm = run(dll, work, cache, str(SHADERS / path), size)
            own = [d for d in cold.get("descs", []) if d not in base_descs[size]]
            problem = cold.get("error") or (cold.get("errors") or [None])[0] or (cold.get("timed_out") and "timed out")
            failed.pop(path, None)
            if problem:
                results[path] = None
                failed[path] = problem
            elif not own or warm.get("error") or warm.get("seconds") is None:
                results[path] = None  # its passes do not run at this scale
            else:
                results[path] = round(max(0.0, cold["seconds"] - warm["seconds"]), 1)
            print(f"{path}: {results[path]} s (cold {cold.get('seconds')}, warm {warm.get('seconds')}, "
                  f"{len(own)} passes){' ' + problem if problem else ''}", flush=True)
    OUTPUT.write_text(json.dumps({
        "device": f"{cpu_name()}，Windows {platform.release()}，Direct3D 11",
        "libmpv": "；".join(versions) + "；libmpv-2.dll sha256 " + hashlib.sha256(Path(dll).read_bytes()).hexdigest()[:16],
        "method": "大河影院自带的 libmpv（gpu-next，Direct3D 11）在 1920×1080 窗口播放 4:2:0 测试图，放大类用 1066×600，"
                  "缩小类用 3840×2160；数值为着色器缓存只有不加着色器的管线时、从开始播放到着色器处理过的画面出来的秒数，"
                  "减去缓存已有这条着色器时的秒数，即首次编译的耗时（主要是 HLSL 转 DXBC，吃 CPU）；"
                  "null 表示没有测到（failed 里是编译失败的原因）。",
        "results": dict(sorted(results.items())),
        "failed": dict(sorted(failed.items())),
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print("wrote", OUTPUT.relative_to(ROOT), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
