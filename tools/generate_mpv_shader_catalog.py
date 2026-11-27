#!/usr/bin/env python3
"""Generate the bundled shader catalog and the shader-library manifest.

The catalog (resources/mpvconf/shaders.json) feeds the settings-page shader
list, the editor's "+" picker and the AI guide. The manifest
(resources/mpv/shaders/manifest.json) lists every bundled shader with its
sha256, so an upgrade replaces or removes only bundled files and never touches
shaders/user/.

Trigger conditions and pass counts are read from each shader's //!HOOK and
//!WHEN headers. Descriptions, content fit, cost and strength come from the
family rules below. Cost tiers are relative and unmeasured until the timing
table in tools/measure_mpv_shaders.py fills them in. Shaders whose first
compile on Windows (Direct3D 11) takes SLOW_COMPILE_SECONDS or longer get
firstCompileSeconds from tools/measure_mpv_shader_compile_d3d11.py; the
client shows it on Windows only.

Run after adding, removing or updating a bundled shader:
    python3 tools/generate_mpv_shader_catalog.py
Pass --check to fail when the checked-in files are stale.
"""
import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SHADERS = ROOT / "resources/mpv/shaders"
CATALOG = ROOT / "resources/mpvconf/shaders.json"
MANIFEST = SHADERS / "manifest.json"
TIMINGS = ROOT / "resources/mpvconf/shader-timings.json"
COMPILE = ROOT / "resources/mpvconf/shader-compile-d3d11.json"
# Below this the first-frame wait is not worth a warning.
SLOW_COMPILE_SECONDS = 5

GROUPS = {
    "Anime4K": "动画修复、放大与线条处理（bloc97/Anime4K）",
    "ArtCNN": "动画向卷积神经网络放大（Artoriuz/ArtCNN）",
    "CfL": "色度重建：用亮度信息恢复被压缩的颜色细节",
    "FSRCNNX": "通用卷积神经网络放大（igv/FSRCNN-TensorFlow）",
    "RAISR": "RAVU 边缘自适应放大（bjin/mpv-prescalers）",
    "SSim": "基于结构相似度的高质量缩放（igv）",
}

SIZE_COST = {"VeryFast": "低", "Fast": "低", "US": "低", "S": "低", "M": "中", "L": "中", "HQ": "中",
             "VL": "高", "UL": "高", "UUL": "极高"}
SIZE_STRENGTH = {"VeryFast": "轻", "Fast": "轻", "US": "轻", "S": "轻", "M": "中", "L": "中", "HQ": "中",
                 "VL": "强", "UL": "强", "UUL": "强"}


def size_of(name):
    for token in ("UUL", "UL", "VL", "VeryFast", "Fast", "HQ", "US", "L", "M", "S"):
        if re.search(rf"_{token}(?:_|$)", name):
            return token
    return None


def describe(group, name):
    """Return title, purpose, content, cost, strength, note for one shader."""
    size = size_of(name)
    cost = SIZE_COST.get(size, "中")
    strength = SIZE_STRENGTH.get(size, "中")
    if group == "Anime4K":
        if name.startswith("Anime4K_Restore_GAN"):
            return ("Anime4K GAN 修复", "修复", "动画",
                    "极高" if "UUL" in name else "高", "强",
                    "用 GAN 模型去除压缩与模糊、重建线条，效果最明显，也最可能产生伪细节；放在放大着色器之前")
        if name.startswith("Anime4K_Restore_CNN_Soft"):
            return ("Anime4K CNN 修复（柔和）", "修复", "动画", cost, "轻" if strength == "轻" else "中",
                    "比普通 Restore 更保守，减少过锐与振铃；放在放大着色器之前")
        if name.startswith("Anime4K_Restore_CNN"):
            return ("Anime4K CNN 修复", "修复", "动画", cost, strength,
                    "去除压缩伪影与模糊并恢复线条；放在放大着色器之前，常见顺序为 修复 → 放大 → 预缩小 → 放大")
        if name.startswith("Anime4K_Upscale_Denoise_CNN"):
            return ("Anime4K CNN 降噪放大 ×2", "放大", "动画", cost, strength,
                    "两倍放大同时降噪，适合噪点或压缩较重的片源；与其他亮度放大着色器二选一")
        if name.startswith("Anime4K_Upscale_GAN_x4"):
            return ("Anime4K GAN 放大 ×4", "放大", "动画", "极高", "强",
                    "一次放大到四倍，锐利但易出现伪细节；只适合低分辨率片源配高分辨率屏幕")
        if name.startswith("Anime4K_Upscale_GAN_x3"):
            return ("Anime4K GAN 放大 ×3", "放大", "动画", "极高", "强",
                    "一次放大到三倍，锐利但易出现伪细节；与其他放大着色器二选一")
        if name.startswith("Anime4K_Upscale_GAN_x2"):
            return ("Anime4K GAN 放大 ×2", "放大", "动画", "高" if size in ("S", "M") else "极高", "强",
                    "比 CNN 放大更锐利，可能产生伪细节；与其他亮度放大着色器二选一")
        if name.startswith("Anime4K_Upscale_CNN"):
            return ("Anime4K CNN 放大 ×2", "放大", "动画", cost, strength,
                    "线条锐利、平涂干净的两倍放大；与其他亮度放大着色器二选一")
        if name.startswith("Anime4K_3DGraphics_AA_Upscale"):
            return ("Anime4K 3D 画面抗锯齿放大 ×2", "放大", "3D 动画 / 游戏画面", "低", "轻",
                    "针对 3D CG 画面的两倍放大，同时减轻锯齿")
        if name.startswith("Anime4K_3DGraphics_Upscale"):
            return ("Anime4K 3D 画面放大 ×2", "放大", "3D 动画 / 游戏画面", "低", "轻",
                    "针对 3D CG 画面的两倍放大")
        if name == "Anime4K_AIO_optQ":
            return ("Anime4K 一体化链（optQ）", "修复 + 放大", "动画", "高", "强",
                    "单个文件里包含钳制高光、修复和两级放大，不要再和其他 Anime4K 修复或放大着色器叠加")
        if name.startswith("Anime4K_AutoDownscalePre"):
            factor = "x4" if name.endswith("x4") else "x2"
            return (f"Anime4K 放大前预缩小（{factor}）", "缩小", "动画", "低", "轻",
                    "多级放大链中间使用：先缩回目标尺寸附近，避免第二级放大过度；放在两个放大着色器之间")
        if name == "Anime4K_Clamp_Highlights":
            return ("Anime4K 高光钳制", "高光处理", "动画", "低", "轻",
                    "限制后续着色器造成的高光过冲和亮边；放在整条链最前面")
        if name.startswith("Anime4K_Darken"):
            return ("Anime4K 线条加深", "线条处理", "动画", cost, strength,
                    "让线条更黑更实，可能让画面变暗；与 Thin 搭配时放在 Thin 之前")
        if name.startswith("Anime4K_Thin"):
            return ("Anime4K 线条收细", "线条处理", "动画", cost, strength,
                    "把粗线条收细，过强会让线条断续；放在放大之后")
        if name.startswith("Anime4K_Deblur"):
            return ("Anime4K 去模糊", "修复", "动画", "低", "轻" if "DoG" in name else "中",
                    "旧版去模糊；新链路建议改用 Restore")
        if name.startswith("Anime4K_Denoise_Bilateral"):
            kind = {"Mean": "均值", "Median": "中值", "Mode": "众数"}[name.rsplit("_", 1)[1]]
            return (f"Anime4K 双边滤波降噪（{kind}）", "降噪", "动画", "低", "轻",
                    "轻度降噪，会损失细小纹理")
        if name in ("Anime4K_Upscale_DoG_x2", "Anime4K_Upscale_Deblur_DoG_x2"):
            return ("Anime4K 旧版放大 ×2（DoG）", "放大", "动画", "低", "轻",
                    "旧版非神经网络放大，开销很低，效果较轻")
        if name in ("Anime4K_Upscale_Original_x2", "Anime4K_Upscale_Deblur_Original_x2"):
            return ("Anime4K 旧版放大 ×2（Original）", "放大", "动画", "低", "轻",
                    "最早期的 Anime4K 放大算法，主要用于对比")
        if name == "Anime4K_Upscale_DTD_x2":
            return ("Anime4K 旧版放大 ×2（DTD）", "放大", "动画", "中", "中",
                    "旧版带去模糊的放大，新链路建议改用 CNN 放大")
    if group == "ArtCNN":
        if "Chroma" in name:
            return ("ArtCNN 色度重建", "色度重建", "动画", "高", "中",
                    "用神经网络重建 4:2:0 色度；与其他色度重建着色器二选一")
        width = "F32" if "F32" in name else "F16" if "F16" in name else "F8"
        tier = {"F8": "低", "F16": "中", "F32": "高"}[width]
        variant = "降噪 + 锐化" if "_DS" in name else "降噪" if "_DN" in name else "标准"
        legacy = "旧版 " if "Legacy" in name else "v0 " if "_v0_" in name else ""
        title = f"ArtCNN {legacy}{width} 放大 ×2（{variant}）"
        note = "两倍放大亮度通道；与其他亮度放大着色器二选一"
        if "YCbCr" in name or "RGB" in name:
            note = "旧版全彩放大，同时处理色度；不要再叠加色度重建着色器"
        if "_CMP" in name:
            note += "；计算着色器版本，在部分显卡上更快"
        return (title, "放大", "动画", tier, "强" if "_DS" in name else "中", note)
    if group == "CfL":
        info = {
            "KrigBilateral": ("KrigBilateral 色度重建", "中", "中", "用亮度结构引导 4:2:0 色度放大，改善彩色线条和边缘"),
            "CfL_Prediction_RT": ("CfL 色度预测（实时版）", "中", "中", "根据亮度预测色度细节"),
            "CfL_Prediction_Lite": ("CfL 色度预测（轻量版）", "低", "轻", "开销更低的色度预测"),
            "JointBilateral_RT": ("联合双边色度重建（实时版）", "低", "轻", "用亮度做引导的双边色度放大"),
            "FastBilateral_RT": ("快速双边色度重建", "低", "轻", "开销最低的色度重建"),
            "kACfL_RT": ("kACfL 自适应色度预测（实时版）", "中", "中", "自适应的亮度引导色度预测"),
        }[name]
        return (info[0], "色度重建", "通用", info[1], info[2], info[3] + "；色度重建着色器之间二选一")
    if group == "FSRCNNX":
        layers = re.match(r"FSRCNNX_x(\d)_(\d+)_", name)
        scale, width = layers.group(1), int(layers.group(2))
        tier = "低" if width <= 8 else "中" if width <= 16 else "高"
        if scale == "1":
            kind = "动画" if "anime" in name else "通用"
            return (f"FSRCNNX 原尺寸修复（{kind}）", "修复", kind, tier, "中",
                    "不改变尺寸，只修复压缩失真；可放在放大着色器之前")
        if "LineArt" in name:
            return ("FSRCNNX 放大 ×2（线稿）", "放大", "动画", tier, "中",
                    "为线稿训练的两倍放大；与其他亮度放大着色器二选一")
        content = "动画" if "anime" in name else "通用"
        variant = "，针对压缩失真训练" if "distort" in name else ""
        return (f"FSRCNNX 放大 ×2（{width} 通道{variant}）", "放大", content, tier, "中",
                "两倍放大亮度通道；与其他亮度放大着色器二选一")
    if group == "RAISR":
        if "zoom" in name:
            return ("RAVU Zoom 放大（R3，抗振铃）", "放大", "通用", "中", "中",
                    "任意倍率的边缘自适应放大；与其他亮度放大着色器二选一")
        return ("RAVU Lite 放大 ×2（R3，抗振铃）", "放大", "通用", "低", "中",
                "开销较低的两倍放大；与其他亮度放大着色器二选一")
    if group == "SSim":
        if "Downscaler" in name:
            return ("SSimDownscaler 高质量缩小", "缩小", "通用", "低", "轻",
                    "高分辨率视频缩小到较小窗口时保持锐度；与 dscale 搭配")
        return ("SSimSuperRes 放大后修正", "放大后处理", "通用", "低", "轻",
                "放大之后修正锐度与振铃；放在放大着色器之后")
    raise SystemExit(f"no description rule for {group}/{name}")


def trigger(text):
    conditions = set(re.findall(r"^//!WHEN (.+)$", text, re.M))
    hooks = sorted(set(re.findall(r"^//!HOOK (\S+)", text, re.M)))
    if not conditions:
        return "始终运行", hooks
    joined = " ".join(conditions)
    if "CHROMA.w LUMA.w <" in joined or "HOOKED.w LUMA.w <" in joined:
        return "只在色度被下采样（4:2:0 / 4:2:2）时运行", hooks
    if "NATIVE.w / 2.0 <" in joined:
        return "只在放大倍数约 1.2–2 倍时运行", hooks
    if "NATIVE.w / 4.0 <" in joined:
        return "只在放大倍数约 2.4–4 倍时运行", hooks
    if "PREKERNEL.w POSTKERNEL.w >" in joined:
        return "只在缩小时运行", hooks
    if "POSTKERNEL.w PREKERNEL.w >" in joined or "HOOKED.w OUTPUT.w <" in joined:
        return "只在放大时运行", hooks
    if "1.200" in joined or "2.400" in joined:
        return "只在输出比片源大约 1.2 倍以上时运行", hooks
    return "按着色器内置条件运行", hooks


def compile_seconds(seconds):
    # Whole seconds; tens from 20 s on, where the CPU decides more than the digit.
    return int(round(seconds)) if seconds < 20 else int(round(seconds, -1))


def build():
    timings = json.loads(TIMINGS.read_text(encoding="utf-8")) if TIMINGS.exists() else {"device": None, "results": {}}
    compiles = json.loads(COMPILE.read_text(encoding="utf-8")) if COMPILE.exists() else {"device": None, "results": {}}
    entries, manifest = [], {}
    # Code-point order of the relative path: Windows paths compare without
    # case, so sorting Path objects would give each platform its own order.
    for path in sorted(SHADERS.rglob("*.glsl"), key=lambda p: p.relative_to(SHADERS).as_posix()):
        relative = path.relative_to(SHADERS).as_posix()
        data = path.read_bytes()
        manifest[relative] = hashlib.sha256(data).hexdigest()
        group = relative.split("/", 1)[0]
        name = path.stem
        title, purpose, content, cost, strength, note = describe(group, name)
        when, hooks = trigger(data.decode("utf-8", "replace"))
        timing = timings.get("results", {}).get(relative)
        if timing is not None:
            timing = round(timing, 1)
        entry = {
            "path": relative,
            "group": group,
            "title": title,
            "purpose": purpose,
            "content": content,
            "trigger": when,
            "hooks": hooks,
            "passes": len(re.findall(rb"^//!HOOK ", data, re.M)),
            "cost": cost,
            "strength": strength,
            "note": note,
            "measuredMs": timing,
        }
        seconds = compiles.get("results", {}).get(relative)
        if seconds is not None and seconds >= SLOW_COMPILE_SECONDS:
            entry["firstCompileSeconds"] = compile_seconds(seconds)
        entries.append(entry)
    catalog = {
        "version": 1,
        "groups": [{"id": key, "title": value} for key, value in GROUPS.items()],
        "costNote": "开销档位（低 / 中 / 高 / 极高）按模型规模排序；括号里的毫秒数是在下面这台设备上实测的每帧 GPU 耗时，"
                    "放大到 1920×1080 时测得，其他设备、分辨率会不同；1 ms 以下的差异受显卡自动降频影响，不能用来排序。",
        "measuredOn": timings.get("device"),
        "firstCompileNote": "Windows 上，标了「首次启用要编译约 N 秒」的着色器第一次用时要先编译，期间画面停住；"
                            "编译结果会缓存，之后再用不用等。秒数在开发者电脑上测得，CPU 越慢越久。",
        "firstCompileMeasuredOn": compiles.get("device"),
        "shaders": entries,
    }
    # Bundles before 2.9.4 also shipped a byte-identical copy of every Anime4K
    # shader at the library root, without a manifest. Listing those copies
    # with their hashes lets the client delete them when they are unchanged.
    retired = {path.split("/", 1)[1]: digest for path, digest in manifest.items()
               if path.startswith("Anime4K/")}
    manifest_doc = {"version": 1, "files": manifest, "retired": retired}
    return (json.dumps(catalog, ensure_ascii=False, indent=2) + "\n",
            json.dumps(manifest_doc, ensure_ascii=False, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    catalog, manifest = build()
    if args.check:
        stale = [p for p, text in ((CATALOG, catalog), (MANIFEST, manifest))
                 if not p.exists() or p.read_text(encoding="utf-8") != text]
        if stale:
            print("stale: " + ", ".join(str(p.relative_to(ROOT)) for p in stale), file=sys.stderr)
            return 1
        return 0
    CATALOG.parent.mkdir(parents=True, exist_ok=True)
    CATALOG.write_text(catalog, encoding="utf-8", newline="\n")
    MANIFEST.write_text(manifest, encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
