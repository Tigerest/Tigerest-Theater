"""Print the download table that opens each version's release notes and CHANGELOG entry.

    python tools/release_download_table.py 2.9.5.3 --platforms windows,mac
    python tools/release_download_table.py 2.9.5.3 --platforms windows,mac --style ref

The table lists every platform. The ones in ``--platforms`` (what this version ships)
link to this version; each other platform links to the newest earlier release on GitHub
that has its package, so a Windows/Mac-only fix still shows where the Android, iPhone /
iPad and Apple TV packages are. Earlier releases are read from the GitHub API
(``GITHUB_TOKEN`` is used when set) or from ``--releases-json``, a saved API response.

``inline`` (default) is for CHANGELOG.md. ``ref`` is for docs/releases/*.md, the GitHub
release body: the table rows stay short and the links go in reference definitions that
belong at the end of the notes, before the ``tigerest-mirrors`` marker. The in-app update
window shows the body as plain text, so long URLs at the top would push the notes down.
"""

import argparse
import json
import os
import sys
import urllib.request

REPOSITORY = "Tigerest/Tigerest-Theater"

# One slot per table row group, in table order. Each slot lists its package variants,
# preferred first: (row label, file suffix, link label, requirements, reference label).
SLOTS = {
    "windows": [[
        ("Windows 安装版", "x64.exe", "EXE", "Windows 10 1903+ / Windows 11，x64", "dl-win-exe"),
        ("Windows 便携版", "x64.zip", "ZIP", "同上；完整解压后运行", "dl-win-zip"),
    ]],
    "android": [[("Android", "android.apk", "APK", "Android 15+，arm64-v8a / x86_64", "dl-android")]],
    "mac": [[("Apple Silicon Mac", "arm64.dmg", "DMG", "macOS 26+，M 系列芯片", "dl-mac")]],
    # 2.9.4 renamed the iPad package to the iPhone/iPad universal one.
    "ios": [[("iPad / iPhone", "universal.ipa", "IPA", "iPadOS / iOS 26+，须自行签名安装", "dl-ios")],
            [("iPad", "ipad.ipa", "IPA", "iPadOS 26+，须自行签名安装", "dl-ipad")]],
    "tvos": [[("Apple TV", "tvos.ipa", "IPA", "tvOS 26+，须为 Apple TV 签名安装", "dl-tvos")]],
}
ORDER = list(SLOTS)


def file_name(version, suffix):
    # The 2.4.1-android.2 prerelease named its APK without the "-android" part.
    if suffix == "android.apk" and "-android." in version:
        return f"TigerestTheater-{version}.apk"
    return f"TigerestTheater-{version}-{suffix}"


def url(version, name):
    return f"https://github.com/{REPOSITORY}/releases/download/v{version}/{name}"


def variant(slot, version, assets):
    """The package variant of ``slot`` on a release page, or None. Without ``assets``
    (a version that is not published yet) the preferred variant is assumed."""
    for packages in SLOTS[slot]:
        if assets is None or all(file_name(version, p[1]) in assets for p in packages):
            return packages
    return None


def github_releases():
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "tigerest-release-notes"}
    if os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = "Bearer " + os.environ["GITHUB_TOKEN"]
    request = urllib.request.Request(f"https://api.github.com/repos/{REPOSITORY}/releases?per_page=100",
                                     headers=headers)
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def rows(version, platforms, releases, assets=None):
    """Yield (label, link text, url, requirements, ref) for every platform, in ORDER.

    ``platforms`` link to ``version``; the rest come from the newest earlier stable release
    in ``releases`` (GitHub API objects) that has the package. When ``version`` is already
    published, "earlier" means published before it. ``assets`` limits this version's own
    rows to files that are really on its page.
    """
    unknown = [key for key in platforms if key not in SLOTS]
    if unknown:
        raise ValueError("unknown platform: " + ", ".join(unknown))
    tag = "v" + version
    this = next((r for r in releases if r["tag_name"] == tag), None)
    earlier = sorted((r for r in releases
                      if r["tag_name"] != tag and not r["draft"] and not r["prerelease"]
                      and "-dev" not in r["tag_name"]
                      and (this is None or r["published_at"] < this["published_at"])),
                     key=lambda r: r["published_at"], reverse=True)
    for slot in ORDER:
        source, packages = None, None
        if slot in platforms:
            source, packages = version, variant(slot, version, assets)
        if packages is None:
            for release in earlier:
                packages = variant(slot, release["tag_name"][1:], {a["name"] for a in release["assets"]})
                if packages:
                    source = release["tag_name"][1:]
                    break
        for label, suffix, kind, needs, ref in packages or []:
            yield label, f"{source} {kind}", url(source, file_name(source, suffix)), needs, ref


def table(version, platforms, releases, style="inline", assets=None, newline="\n"):
    """Return (table, reference definitions). Definitions are empty for ``inline``."""
    found = list(rows(version, platforms, releases, assets))
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
                        help="what this version ships, comma separated: " + ", ".join(ORDER))
    parser.add_argument("--style", choices=["inline", "ref"], default="inline")
    parser.add_argument("--releases-json", help="saved GitHub releases API response instead of a request")
    args = parser.parse_args()
    platforms = [p.strip() for p in args.platforms.split(",") if p.strip()]
    if args.releases_json:
        with open(args.releases_json, encoding="utf-8") as file:
            releases = json.load(file)
    else:
        releases = github_releases()
    try:
        text, refs = table(args.version.lstrip("v"), platforms, releases, args.style)
    except ValueError as error:
        parser.error(str(error))
    sys.stdout.reconfigure(encoding="utf-8")
    print(text)
    if refs:
        print("\n<!-- 放在发布说明末尾、tigerest-mirrors 标记之前 -->")
        print(refs)


if __name__ == "__main__":
    main()
