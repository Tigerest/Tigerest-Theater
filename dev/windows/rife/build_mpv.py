"""Check and prepare the pinned mpv source for the Windows RIFE build."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

from probe_runtime import write_report

SOURCE_SHA = "dd5d17d3285a095a0f712fa9d116e22a076492de"
WINBUILD_SHA = "cd1edc11dc6887a50f705717619d879f5a93a488"
EOF_PATCH = Path(__file__).resolve().parents[2] / "macos/rife/mpv-eof-aware.patch"
PRIVATE_CORE_PATCH = Path(__file__).with_name('mpv-private-vs-core.patch')
HWDEC_PATCH = Path(__file__).with_name('mpv-win64-hwdec-pointer.patch')
QUEUE_PATCH = Path(__file__).with_name('mpv-win64-queue-pointer.patch')
FLIP_PATCH = Path(__file__).with_name('mpv-win32-precise-flip.patch')


def check_source(source):
    result = {"ok": False, "sourceSha": None, "eofPatchApplicable": False}
    try:
        actual = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"],
                                         text=True, stderr=subprocess.STDOUT).strip()
        result["sourceSha"] = actual
        if actual != SOURCE_SHA:
            result.update(errorCode="source-sha", error="The source does not match the Windows baseline")
            return result
        subprocess.run(["git", "-C", str(source), "diff", "--exit-code", "HEAD"],
                       check=True, capture_output=True)
        subprocess.run(["git", "-C", str(source), "apply", "--check", str(EOF_PATCH), str(PRIVATE_CORE_PATCH), str(HWDEC_PATCH), str(QUEUE_PATCH), str(FLIP_PATCH)],
                       check=True, capture_output=True)
        result.update(ok=True, eofPatchApplicable=True, privateCorePatchApplicable=True,
                      hwdecPatchApplicable=True, hwdecPatchSha256=hashlib.sha256(HWDEC_PATCH.read_bytes()).hexdigest(),
                      queuePatchApplicable=True, queuePatchSha256=hashlib.sha256(QUEUE_PATCH.read_bytes()).hexdigest(),
                      flipPatchApplicable=True, flipPatchSha256=hashlib.sha256(FLIP_PATCH.read_bytes()).hexdigest(),
                      privateCorePatchSha256=hashlib.sha256(PRIVATE_CORE_PATCH.read_bytes()).hexdigest(),
                      eofPatchSha256=hashlib.sha256(EOF_PATCH.read_bytes()).hexdigest())
    except subprocess.CalledProcessError as error:
        output = error.stderr or error.output or b""
        if isinstance(output, bytes):
            output = output.decode("utf-8", errors="replace")
        result.update(errorCode="source-check", error=output.strip())
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-source", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    result = check_source(args.check_source.resolve())
    write_report(args.report, result)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
