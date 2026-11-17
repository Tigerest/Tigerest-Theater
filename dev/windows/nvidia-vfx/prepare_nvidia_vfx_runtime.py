"""Stage the hash-pinned NVIDIA Video Effects runtime used by frame generation.

The files come unmodified from NVIDIA's nvidia-vfx wheel. Either the wheel is
downloaded from NVIDIA's package index (or given with --wheel) and checked
against its published SHA-256, or loose copies of the same files are given with
--from-dir/--licenses-from; every file is checked against runtime-lock.json.
"""
import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import urllib.request
import zipfile

HERE = Path(__file__).resolve().parent


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def verify(path, entry, what="NVIDIA runtime file"):
    if not path.is_file() or path.is_symlink():
        raise ValueError(f"{what} is missing: {path.name}")
    if path.stat().st_size != entry["size"] or sha256(path) != entry["sha256"]:
        raise ValueError(f"{what} checksum/size mismatch: {path.name}")


def layout(lock):
    """(lock entry, path relative to the output directory) for every staged file."""
    for name, entry in lock["runtime"].items():
        yield entry, Path(name)
    for name, entry in lock["licenses"].items():
        yield entry, Path("licenses") / name


def load_lock():
    lock = json.loads((HERE / "runtime-lock.json").read_text(encoding="utf-8"))
    if lock["schemaVersion"] != 1:
        raise ValueError("Unsupported NVIDIA runtime lock")
    return lock


def fetch_wheel(lock, wheel, offline):
    entry = lock["wheel"]
    if wheel is None:
        raise ValueError("No wheel given")
    if not wheel.exists():
        if offline:
            raise ValueError("Offline wheel missing: " + str(wheel))
        wheel.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="nvidia-vfx-download-", dir=wheel.parent) as temporary:
            download = Path(temporary) / wheel.name
            print("Downloading", entry["url"], f"({entry['size'] / 1e6:.0f} MB)", flush=True)
            with urllib.request.urlopen(entry["url"], timeout=120) as response, download.open("wb") as destination:
                shutil.copyfileobj(response, destination, 1 << 20)
            verify(download, entry, "NVIDIA wheel")
            os.replace(download, wheel)
    verify(wheel, entry, "NVIDIA wheel")
    return wheel


def prepare(output, wheel=None, from_dir=None, licenses_from=None, offline=False):
    lock = load_lock()
    if output.exists():
        for entry, relative in layout(lock):
            verify(output / relative, entry)
        shutil.copyfile(HERE / "runtime-lock.json", output / "runtime-lock.json")
        shutil.copyfile(HERE / "NOTICE.txt", output / "NOTICE.txt")
        print("Verified existing NVIDIA runtime:", output)
        return
    archive = None if from_dir else fetch_wheel(lock, wheel, offline)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="nvidia-vfx-stage-", dir=output.parent) as temporary:
        staged = Path(temporary) / "runtime"
        (staged / "licenses").mkdir(parents=True)
        with (zipfile.ZipFile(archive) if archive else contextlib.nullcontext()) as source:
            for entry, relative in layout(lock):
                target = staged / relative
                if archive:
                    with source.open(entry["member"]) as member, target.open("wb") as destination:
                        shutil.copyfileobj(member, destination, 1 << 20)
                else:
                    origin = (licenses_from if relative.parent.name == "licenses" else from_dir) / relative.name
                    verify(origin, entry)
                    shutil.copyfile(origin, target)
                verify(target, entry)
        shutil.copyfile(HERE / "runtime-lock.json", staged / "runtime-lock.json")
        shutil.copyfile(HERE / "NOTICE.txt", staged / "NOTICE.txt")
        os.rename(staged, output)
    print("Prepared verified NVIDIA runtime:", output)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--wheel", type=Path, help="NVIDIA's wheel; downloaded here when it does not exist yet "
                        "(default build/nvidia-vfx-downloads/<wheel file>)")
    parser.add_argument("--offline", action="store_true", help="never download the wheel")
    parser.add_argument("--from-dir", type=Path, help="loose runtime DLLs instead of the wheel")
    parser.add_argument("--licenses-from", type=Path, help="loose license files (with --from-dir)")
    args = parser.parse_args()
    if bool(args.from_dir) != bool(args.licenses_from):
        parser.error("--from-dir and --licenses-from go together")
    try:
        wheel = None
        if not args.from_dir:
            wheel = (args.wheel or HERE.parents[2] / "build/nvidia-vfx-downloads" / load_lock()["wheel"]["file"]).resolve()
        prepare(args.output.resolve(), wheel, args.from_dir and args.from_dir.resolve(),
                args.licenses_from and args.licenses_from.resolve(), args.offline)
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        parser.exit(1, str(error) + "\n")


if __name__ == "__main__":
    main()
