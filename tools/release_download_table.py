"""Print the download table that opens each version's release notes and CHANGELOG entry.

    python tools/release_download_table.py 2.9.5.3 --platforms windows,mac
    python tools/release_download_table.py 2.9.5.3 --platforms windows,mac --style ref

``inline`` (default) is for CHANGELOG.md. ``ref`` is for docs/releases/*.md, the GitHub
release body: the table rows stay short and the links go in reference definitions that
belong at the end of the notes, before the ``tigerest-mirrors`` marker. The in-app update
window shows the body as plain text, so long URLs at the top would push the notes down.
"""

import argparse
import sys

REPOSITORY = "Tigerest/Tigerest-Theater"

# key, row label, file suffix, link label, requirements, reference label
PACKAGES = {
    "windows": [
        ("Windows 安装版", "x64.exe", "EXE", "Windows 10 1903+ / Windows 11，x64", "dl-win-exe"),
        ("Windows 便携版", "x64.zip", "ZIP", "同上；完整解压后运行", "dl-win-zip"),
    ],
    "android": [("Android", "android.apk", "APK", "Android 15+，arm64-v8a / x86_64", "dl-android")],
    "mac": [("Apple Silicon Mac", "arm64.dmg", "DMG", "macOS 26+，M 系列芯片", "dl-mac")],
    "ios": [("iPad / iPhone", "universal.ipa", "IPA", "iPadOS / iOS 26+，须自行签名安装", "dl-ios")],
    "ipad": [("iPad", "ipad.ipa", "IPA", "iPadOS 26+，须自行签名安装", "dl-ipad")],
    "tvos": [("Apple TV", "tvos.ipa", "IPA", "tvOS 26+，须为 Apple TV 签名安装", "dl-tvos")],
}
ORDER = ["windows", "android", "mac", "ios", "ipad", "tvos"]


def file_name(version, suffix):
    # The 2.4.1-android.2 prerelease named its APK without the "-android" part.
    if suffix == "android.apk" and "-android." in version:
        return f"TigerestTheater-{version}.apk"
    return f"TigerestTheater-{version}-{suffix}"


def url(version, name):
    return f"https://github.com/{REPOSITORY}/releases/download/v{version}/{name}"


def rows(version, platforms, assets=None):
    """Yield (label, link text, url, requirements, ref) for each package, in ORDER.

    With ``assets`` (a set of file names on the release page), packages that are not
    there are left out.
    """
    unknown = [key for key in platforms if key not in PACKAGES]
    if unknown:
        raise ValueError("unknown platform: " + ", ".join(unknown))
    for key in ORDER:
        if key not in platforms:
            continue
        for label, suffix, kind, needs, ref in PACKAGES[key]:
            name = file_name(version, suffix)
            if assets is not None and name not in assets:
                continue
            yield label, f"{version} {kind}", url(version, name), needs, ref


def table(version, platforms, style="inline", assets=None, newline="\n"):
    """Return (table, reference definitions). Definitions are empty for ``inline``."""
    found = list(rows(version, platforms, assets))
    if not found:
        return "", ""
    lines = ["| 平台 | 安装包 | 系统要求 |", "| --- | --- | --- |"]
    refs = []
    for label, text, link, needs, ref in found:
        target = f"[{ref}]" if style == "ref" else f"({link})"
        lines.append(f"| {label} | [{text}]{target} | {needs} |")
        refs.append(f"[{ref}]: {link}")
    return newline.join(lines), (newline.join(refs) if style == "ref" else "")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("version", help="for example 2.9.5.3")
    parser.add_argument("--platforms", required=True,
                        help="comma separated: " + ", ".join(ORDER))
    parser.add_argument("--style", choices=["inline", "ref"], default="inline")
    args = parser.parse_args()
    platforms = [p.strip() for p in args.platforms.split(",") if p.strip()]
    try:
        text, refs = table(args.version.lstrip("v"), platforms, args.style)
    except ValueError as error:
        parser.error(str(error))
    sys.stdout.reconfigure(encoding="utf-8")
    print(text)
    if refs:
        print("\n<!-- 放在发布说明末尾、tigerest-mirrors 标记之前 -->")
        print(refs)


if __name__ == "__main__":
    main()
