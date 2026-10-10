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

# Windows release compositor regression

Every update containing Windows packages must complete
`dev/windows/RELEASE_CHECKLIST.md` before publication, including the packaged
displayed-pixel test on an actual hardware GPU and real-library hover/scroll
checks at the user's normal display refresh and mouse polling rates.
The report must match the exact packaged EXE and QtWebEngine DLL hashes.
Startup, DLL hashes, a producer-wait log, CDP screenshots, or a software GPU
fixture alone do not establish that the window is free of corruption.
Missing checks, captured damage, or a still-reproducible report block release;
do not silently waive them or label the problem fixed.
