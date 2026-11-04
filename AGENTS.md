# Windows builds and tests

Before running CTest or a native test executable, read `dev/windows/TESTING.md`
and dot-source `dev/windows/Enter-TestEnvironment.ps1` in the **same PowerShell
invocation** as the test command. The runtime environment is not retained between
tool calls. Never launch `build/tests/*.exe` directly without this setup.

The setup must find `libmpv-2.dll`, the RIFE bridge, Qt DLLs and both Windows and
offscreen platform plugins. A missing dependency is a terminal preflight error;
fix it before launching tests. Do not ask the user to dismiss repeated DLL or Qt
plugin error dialogs, or suggest reinstalling their player to fix a test harness.

Use isolated test profiles for playback/UI checks; preserve the installed player
and its settings. Report actual test results and distinguish fixture verification
from production API and real playback validation.

# Release notes and CHANGELOG

Every version's `CHANGELOG.md` entry and its `docs/releases/<date>-v<version>.md`
(the GitHub release body) open with a download table of the packages that version
ships: platform, package link, system requirements. Put it right under the
`## v<version>` heading in the CHANGELOG and right under the `#` title in the release
notes. Generate it instead of typing it:

    python tools/release_download_table.py 2.9.5.3 --platforms windows,mac
    python tools/release_download_table.py 2.9.5.3 --platforms windows,mac --style ref

The CHANGELOG uses the default inline links. The release notes use `--style ref`:
the in-app update window shows the body as plain text, so the link definitions go at
the end, before the `tigerest-mirrors` marker. List only the platforms published in
that version; when another platform's package joins the same release page later, add
its row to both tables.
