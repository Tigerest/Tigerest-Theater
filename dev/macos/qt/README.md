# Mac display-link experiment (Qt 6.9.3)

Status: the locally packaged arm64 **2.6.1 release includes these patches** after isolated preview validation and user acceptance. The generic `build-macos.yml` workflow does not build this engine either; its arm64 job copies it from the pinned, checksummed release DMG with `use_patched_webengine.py`, as release builds do. Native playback results, the final review, and remaining preview limitations are recorded in `docs/reports/2026-10-14-mac-120hz.md`.

The stock Qt WebEngine compositor receives `display_id = -1` on macOS. Chromium's `ExternalBeginFrameSourceMac` then uses a 16.666 ms timer instead of a display link. On the test Mac, QScreen and CoreVideo both report 120 Hz, headed Chrome delivers ~120 rAF callbacks/s, and stock Qt delivers ~60 callbacks/s and ~60 Qt window submissions/s. Merely switching Qt Quick to Metal does not change this.

`macos-display-link.patch` supplies a CoreGraphics display ID whenever the WebEngine view updates its screen information, including an explicit screen-change notification. It uses the screen containing the QScreen geometry center, not Qt's indexed display ID. A failed mapping discards the stale display ID and allows Chromium's normal fallback. Chromium owns the display link; no fixed 120 Hz timer or unlimited-frame flag is used.

Source archive: [QtWebEngine 6.9.3](https://download.qt.io/archive/qt/6.9/6.9.3/submodules/qtwebengine-everywhere-src-6.9.3.tar.xz)

SHA256: `d50b3b11d51dd876418cc36b4d6c96b4721e0aab773a3dd6beda606d46da8966`

Apply all five compatibility/display/decode patches in this directory to the extracted source with `patch -p1`. Besides the display-link change, they restore an SDK declaration, select the actual architecture's linker response file for a single-architecture Mac build, and make out-of-tree generated extension headers discoverable with valid include guards. These compatibility changes retain the existing enabled features.

Build outside the repository and installed application. Use the existing Qt 6.9.3 SDK's `qt-cmake` and `libexec/gn` (version `6.9.3.qtwebengine.qt.io`), Xcode 27, an isolated Python 3.9 environment with html5lib 1.1, and these CMake settings:

```text
CMAKE_BUILD_TYPE=Release
CMAKE_OSX_ARCHITECTURES=arm64
CMAKE_OSX_DEPLOYMENT_TARGET=12.0
CMAKE_INSTALL_PREFIX=<isolated-install>
Python3_EXECUTABLE=<isolated-python>
Gn_EXECUTABLE=<qt-sdk>/libexec/gn
FEATURE_webengine_build_gn=OFF
QT_FEATURE_qtpdf_build=OFF
QT_BUILD_TESTS=OFF
QT_BUILD_EXAMPLES=OFF
QT_SHOW_EXTRA_IDE_SOURCES=OFF
```

Ensure `xcrun metal --version` succeeds with the selected Xcode. If Xcode reports a missing Metal Toolchain, install its matching component with `xcodebuild -downloadComponent MetalToolchain`.

The **dependency** deployment target matches the official Qt 6.9.3 framework's `LC_BUILD_VERSION` (12.0). Building that old engine with a 26.0 minimum causes Xcode 27 to reject legacy WebRTC capture interfaces that were obsoleted in 15.0. The Tigerest application itself retains its 26.0 minimum; this does not add support for older macOS versions.

Place `<qt-sdk>/libexec` on PATH during the build as well: the GN generation subprocess locates GN independently of the configure cache. The first probe only needs `WebEngineCore`, `WebEngineQuick`, `QtWebEngineProcess`; build the complete module before installing, so the WebEngine QML plugin and delegates match too. The standalone QtPdf module is omitted; WebEngine's printing/PDF support remains enabled.

For an isolated install (paths are examples to replace with your own):

```sh
export DEVELOPER_DIR='/path/to/Xcode-beta.app/Contents/Developer'
export PATH='/path/to/qt/6.9.3/macos/libexec':"$PATH"
cmake --build /path/to/qtwebengine-build -j 8
# Qt's installer expects GN here even when using the matching prebuilt tool.
mkdir -p /path/to/qtwebengine-build/install/bin
cp /path/to/qt/6.9.3/macos/libexec/gn /path/to/qtwebengine-build/install/bin/gn
cmake --install /path/to/qtwebengine-build --prefix /path/to/isolated-webengine
```

Use a separate copy of the matching full Qt SDK when integrating this module into a normal application build. Overlay this install there and point the app's `QTROOT` and `CMAKE_PREFIX_PATH` to that copy, so `macdeployqt` packages the candidate instead of silently copying stock WebEngine. Do not overwrite the original SDK or installed application. Verify the bundled helper, resources, locales and QML/delegate components as well as the main framework.

Before enabling the patch in packaging, verify the actual display ID in Chromium logging, rAF cadence, Qt window submissions, 60 Hz fallback, monitor migration, idle/minimized behavior and native player integration. Window submissions and rAF are not proof of physical screen presentation.

Build the small `probe/` CMake project with the same Qt SDK, then run:

```sh
node tests/bench_frame_source.cjs /absolute/path/TigerestFrameProbe.app/Contents/MacOS/TigerestFrameProbe \
  --backend=metal --hz=120 --assert-target --output=/absolute/path/frame-source.json
```

Run without concurrent builds and with the probe foreground on the intended display. The stock engine fails this check (~60 rAF/s, ~60 window submissions/s); test both `metal` and `opengl` against the candidate framework. The probe uses an off-the-record web profile and only loopback fixture content.

UI benchmark (isolated synthetic library; no server credentials):

```sh
node tests/bench_home_motion.cjs '<client-or-Chrome>' --webengine \
  --rounds=3 --dpr=2 --hz=120 --output=/absolute/path/report.json
```

Omit `--webengine` for Chrome. The benchmark uses visible GPU rendering, matching 1280×720/DPR2 geometry, and the production transition/appearance code. Default scrolling is driven by the page at 1000 CSS pixels/s; it is not a physical trackpad-input test. `--scroll=native` adds a CDP wheel-gesture check in Chrome; Qt does not complete that CDP operation. Never compare benchmark runs while compiling the dependency.

Xcode 27 also drops the `kSBXProfilePureComputation` declaration from `sandbox.h` while still exporting the exact symbol from libSystem. Apply `xcode27-sandbox-declaration.patch` when using this SDK. It restores only the declaration, preserving the existing profile and sandbox behavior. A linked/run symbol probe on the test Mac returns `pure-computation`.

The frame probe supports `--lifecycle` to check settled idle, minimized, hidden and restored Qt submissions. On this launch setup both Qt and direct AppKit requests fail to actually miniaturize the native window, so the strict combined test correctly fails that exercise precondition. This is not evidence of background rendering in a successfully minimized client. Actual hiding and idle both produce zero window submissions; restoring returns to high refresh. Minimization still needs independent validation. `PROBE_NATIVE_ANIMATION=1` adds a small Qt Quick rotation to distinguish the native scene's clock from WebEngine's. Do not use this extra animation for the idle check.

When testing a temporary 60 Hz mode with `CGDisplaySetDisplayMode`, keep the requesting process alive, verify the **current** mode while it is alive, and restore/verify the original mode in `finally`. macOS restores an app-requested mode when that app exits; launching a short-lived setter and then running the benchmark measures the original mode by mistake. With the setter held alive, the candidate follows 60 Hz (~59.995 rAF/s and ~60 Qt submissions/s).

Use `--viewport=fullscreen` for an additional measurement at the real client viewport without CDP size emulation. The collector pre-rolls rAF before invoking the action so its first delay is retained, and reports startup latency separately. Do not discard preparation hitches when reporting aggregate performance. The standalone full-screen preview scrolls at 120 rAF/s; transition averages remain ~109–118, with occasional route-preparation hitches and larger first-run stalls. These are scheduling measurements, not physical presentation.

For local delivery, keep `launch-preview.command` beside `Applications/Tigerest Theater.app`. It uses a separate configuration root and a uniquely named profile (also separating local IPC sockets). Run it to open the preview; do not directly launch the inner app against the installed player's default profile. The preview requires its own login. It does not replace the installed application.

## Small raster decode experiment

`macos-async-small-image-bitmap.patch` is an additional optional experiment. It moves original bitmap decoding for explicit output sizes up to 240×512 off the renderer thread on macOS, while preserving the existing crop/resize/color/alpha processing and origin status. The DOM resource itself never crosses threads; its encoded bytes and metadata are captured at call time. It does not add network requests or change the SVG/other-size paths. It has passed local pixel/security, transition and native playback checks; it remains optional and is not a release default.

The pinned Chromium raster constructor explicitly redecodes image frame zero synchronously. See [the upstream ImageBitmap implementation](https://chromium.googlesource.com/chromium/src/+/16bdaadbeabe2d8b61297cc160bb0c642a76a7a6/third_party/blink/renderer/core/imagebitmap/image_bitmap.cc); use the locally pinned source when applying this patch. The existing Blob/SVG worker paths provided the lifetime pattern for the experiment.

Generate a local corpus (Pillow is required), then run the same probe against the unmodified and modified engine. Store the first JSON as the pixel reference; the expected-corpus hashes must match. A supplied ICC profile is kept only in the local generated corpus.

```sh
python3 dev/macos/qt/generate-bitmap-fixtures.py --output=/absolute/empty/corpus \
  --icc-profile='/System/Library/ColorSync/Profiles/Display P3.icc'
node tests/bench_image_bitmap.cjs '<client>' --webengine \
  --fixtures=/absolute/empty/corpus --output=/absolute/before.json
node tests/bench_image_bitmap.cjs '<candidate-client>' --webengine \
  --fixtures=/absolute/empty/corpus --output=/absolute/after.json \
  --expect=/absolute/before.json --assert-async
```

The reference includes 18 exact pixel checks (alpha, ICC, EXIF, crops, filters, 16-bit input, animated frame zero and src mutation), cross-origin readback/transfer checks, a destroyed-caller exercise, and surviving-parent completion with matching pixels after the source iframe is removed. Completion is scheduled on the caller execution context, independent of the source document lifetime. The timing gate checks the synchronous part of large-JPEG extraction against the 8.33 ms UI budget. Native results are 73.5 ms before and 2.0 ms in the standalone candidate, with matching pixels. Forced empty-cache real-library home→detail runs improved from 76.77/85.16 to 109.56/117.18 rAF/s (worst interval 209.7→32.2 ms), but ordinary warm navigation did not show a clear gain. This is not a whole-interface 120 fps claim. See the dated report and sanitized async-bitmap metrics for both positive and negative evidence.

## Later releases

The ordinary `bundle.sh` deploys the SDK's stock WebEngine, which locks the whole UI to 60 Hz (2.9.0 local builds regressed this way). Set `TIGEREST_PATCHED_WEBENGINE_SOURCE` to a verified release bundle (for example the installed 2.8.0 app) before running it. `dev/macos/use_patched_webengine.py` then replaces the three WebEngine frameworks and two QML plugins, refuses any source whose QtWebEngineCore UUID is not `76AE7891-C29A-31D6-815F-C1505E445F07`, and records the engine's origin in `build-provenance.json` before signing. Only these WebEngine files differ between the stock and patched 2.8.0 bundles. Verify the result with an isolated rAF measurement at 120 Hz: stock ~60 callbacks/s, patched ~118.

## 2.6.1 release packaging

Use the verified standalone patched bundle as the runtime source, rebuild the client with `VERSION=2.6.1`, and update its executable plus Info.plist. Do not run the ordinary build's `ninja install`/`macdeployqt` over this bundle: its SDK may still contain stock WebEngine. The bundled QtWebEngineCore UUID must match the patched install (`76AE7891-C29A-31D6-815F-C1505E445F07` in this build), not the official SDK. Replace local-preview metadata with `Contents/Resources/build-provenance.json` containing the final source commit, engine patch commit, patch digests and UI digests. Run `dev/macos/sign_bundle.py`, `tests/test_macos_bundle.py`, isolated launch checks, then create the normal DMG containing only the application and Applications link. No preview profile or launcher is included. The release remains ad-hoc signed, not notarized.
