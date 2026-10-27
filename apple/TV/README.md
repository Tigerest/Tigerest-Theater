# Apple TV client

Since 2.9.3 the Apple TV client also connects to Jellyfin (10.9.11 to 12.2, root and `/jellyfin` sub-paths, verified on an Apple TV 4K). See the [connection and compatibility guide](../../docs/jellyfin-compatibility.md) and [Apple results](../../docs/verification/2026-10-19-jellyfin-apple-results.md). Apple TV still has no Watch Together or RIFE.

The native television client is distributed as the [`TigerestTheater-2.9.5-tvos.ipa`](https://github.com/Tigerest/Tigerest-Theater/releases/download/v2.9.5/TigerestTheater-2.9.5-tvos.ipa) attachment on the 2.9.5 release page. From 2.9.5 the dedicated server's public services are HTTPS; a saved dedicated sign-in moves to the new address and stays signed in. Requires tvOS26+ and Xcode27 for source builds. The independent `TigerestTV.xcodeproj` shares AppleCore and the pinned MPVKit revision with iPad without importing its WebHost or touch controls.

The public IPA is unsigned and contains no developer account or provisioning profile. Sign it for your own paired Apple TV before installing, or build and install from Xcode using your own team. It is not an App Store or TestFlight download. `tvos.ipa` and `universal.ipa` (the iPad/iPhone build, named `ipad.ipa` up to 2.9.3) are separate device builds and cannot be interchanged.

Implemented: dedicated/self-host server selection from shared bundled defaults, Emby login and device-local Keychain session, original library artwork and a focus-driven home hero/poster rail with continue-watching/latest ordering, a recursive paginated poster wall, series/seasons/episodes with SXXEXX labels, rich details with available year/runtime/genre/people/media metadata, in-place season/episode selection, detail/play/resume, native Metal playback, remote play/pause, ±10-second seek, previous/next episodes and a season-aware episode picker, back/exit, progress reporting and immediate local resume updates. API calls preserve reverse-proxy paths; media requests do not carry custom authentication headers to external servers. Passwords are not stored. Subtitle tracks preserve Emby defaults and use actual MPV track IDs, with embedded/external selection, explicit off, timing adjustment and non-fatal failure messages. The shared iPad danmaku repository, matching rules, glyph renderer and playback clock are reused, with TV search/source/offset controls. Native comments support private/public feeds, work/episode contexts, paging, replies, sending and deleting owned comments. Public credentials use a separate Keychain record and token-refresh lifecycle; no Emby token is sent to public or arbitrary danmaku providers. Comments are inline below detail information with a shared vertical scrolling surface, and quality settings are available outside playback. RIFE is not linked or bundled. Watch Together is not included in the TV release: the production room service does not yet accept tvOS clients.

2.9.4 adds library sorting (name, date added, release date, rating) and search, unwatched/watched badges and progress bars on posters and episode cards, watch state on details, a back key that first hides the playback controls, and text subtitles about 15% larger.

## Build

Select the installed Xcode27 Developer directory using `DEVELOPER_DIR` (beta is supported), then from repository root:

```sh
python3 apple/tools/generate_tv_project.py
xcodebuild -project apple/TigerestTV.xcodeproj -scheme TigerestTV \
  -configuration Release -derivedDataPath apple/DerivedDataTV \
  -clonedSourcePackagesDirPath apple/DerivedData/SourcePackages \
  -sdk appletvos -destination 'generic/platform=tvOS' CODE_SIGNING_ALLOWED=NO build
```

For device installation, pair the Apple TV in Xcode, choose the existing Personal Team through local `apple/Local.xcconfig`, and build with signing enabled. The generator does not embed personal signing settings. Device provisioning, trust and a real login must be completed before claiming hardware playback validation.

Package a generic device Release build for redistribution:

```sh
python3 apple/tools/package_ipa.py --platform tvos \
  --app apple/DerivedDataTV/Build/Products/Release-appletvos/TigerestTV.app \
  --output /absolute/path/to/empty-release-directory
```

The packager removes signatures and personal profiles from a temporary copy,
verifies tvOS architecture/platform, icons, shaders, artwork, subtitle font and
license, and rejects fixture media or RIFE. It emits the IPA and a validation
report. Publish the source revision and SHA-256 alongside the IPA.

## Tests

```sh
(cd apple/Core && swift test)
```

For isolated UI/playback/subtitle checks, generate a local 45-second 720p/24 H.264/AAC fixture with a Chinese mov_text subtitle track (requires ffmpeg), then opt it into the project:

```sh
python3 apple/tools/generate_tv_test_media.py /absolute/path/fixture.mp4
python3 apple/tools/generate_tv_project.py --fixture-media /absolute/path/fixture.mp4
xcodebuild -project apple/TigerestTV.xcodeproj -scheme TigerestTV \
  -derivedDataPath apple/DerivedDataTV \
  -clonedSourcePackagesDirPath apple/DerivedData/SourcePackages \
  -destination 'platform=tvOS Simulator,name=Apple TV 4K (3rd generation)' test
python3 apple/tools/generate_tv_project.py
```

The seven tests use actual `XCUIRemote` directional/select/play-pause/menu events. They check season/episode and focus restoration, both server-entry forms, and advancing video position followed by pause/resume/exit and updated resume position, plus real player episode switching, replacing detail selections across seasons without growing the return stack, home preview/hero navigation, returning from home details to the selected library poster, the quality panel and selecting/disabling an actual embedded subtitle. The subtitle test retains a screenshot for visual inspection. `--tv-fixture` neither loads nor writes Keychain credentials; local playback in this mode skips server reports. Fixture quality starts independently and never reads or writes the installed quality preference. The optional test file is removed from project resources by normal generation. Keep test data separate from real media and credentials.

## Physical playback timing

Use a silent local fixture at least 240 seconds long (for example 1080p HEVC at 24 or 60 FPS), the signed Release configuration, and the dedicated performance scheme. Close Device Hub remote previews before measuring. The performance test plan explicitly disables automatic XCTest screen recording; deleting recordings after a successful test does not remove their runtime GPU load.

```sh
python3 apple/tools/generate_tv_project.py --fixture-media /absolute/path/240-second-fixture.mp4
xcodebuild -project apple/TigerestTV.xcodeproj -scheme TigerestTVPerformance \
  -configuration Release -derivedDataPath apple/DerivedDataTV \
  -clonedSourcePackagesDirPath apple/DerivedData/SourcePackages \
  -destination 'platform=tvOS,id=YOUR_PAIRED_DEVICE_UDID' \
  'SWIFT_ACTIVE_COMPILATION_CONDITIONS=$(inherited) TV_PERFORMANCE_TEST' test
python3 apple/tools/generate_tv_project.py
```

The opt-in test checks three minutes of progression, pause/resume, seek and exit. Its pass does **not** assert zero dropped frames: collect the allowlisted probe samples separately, check their timestamps, and compare counters within uninterrupted segments (MPV resets counters after seeking). Restore the normal non-fixture build after device checks.

## Verified scope and remaining work

2026-10-15, Xcode27.2 beta: shared AppleCore 100 tests, five danmaku host tests, twenty-eight home/episode-model tests, twenty-three playback/subtitle-controller tests and seven comments-model tests passed. All seven native remote UI tests passed; the subtitle test also passed again after the font fix, and its screenshot was inspected to confirm correctly rendered Chinese text. Controller tests cover quality rollback, generation handoff, subtitle track selection, pending external loads and diagnostic isolation. Native remote UI tests use generated local media, not production server playback. Both signed device TV and iPad Release builds passed after the shared danmaku extraction.

2026-10-16 follow-up: 35 playback/subtitle-controller tests and the shared quality-resource test passed. The home/quality simulator check and lightweight playback/pause/exit check passed. Two opt-in Release performance runs passed on the A12 Apple TV using silent, generated 1080p HEVC fixtures and a 3840×2160 drawable, with remote pause/resume, forward seek and exit. For 24 FPS, sampled effective quality remained lightweight through position 199.25 s with zero render/decoder drops in all recorded samples; summed GPU pass averages were about 31 ms. For 60 FPS, the conservative high-frame-rate policy selected effective native while keeping the lightweight preference: GPU pass averages were about 6.15 ms. This was not a zero-drop run: the pre-seek counter reached 24 near position 98.28 s (including startup/operations); after the seek reset, it rose from 0 at 117.95 s to 6 at 198.73 s. Decoder drops stayed zero. These are controlled fixture checks, not a universal guarantee for real server media or long sessions with danmaku/HDR.

Earlier performance runs were affected by an active/hung Device Hub preview and XCTest automatic screen recording (an MP4 was confirmed in the failed result bundle). Their higher render times must not be presented as shader-only hardware limits. The final timing runs closed the preview and used the dedicated capture-disabled test plan. The 48 FPS threshold remains a conservative stability policy. The original full desktop preset and shared Mac/iPad quality profiles remain unchanged.

The TV bundle includes unmodified Source Han Sans SC under its SIL Open Font License so text subtitles do not depend on unavailable system CJK fallback fonts. ASS styles and embedded fonts remain enabled. Source revision and hash are recorded in `apple/Resources/SubtitleFonts/README.md`.

On the paired Apple TV 4K (2nd generation / A12), tvOS27.0, the final signed non-fixture build was installed and launched normally, preserving the existing login. The original home artwork/hero/rail, library poster wall, series/season/episode navigation, S01E01 labels, current-episode selection, inline comments below media information, and return to the originating library poster were checked on this build. Earlier physical checks verified actual private/public comment reads and automatic danmaku: the sampled episode loaded 6,810 entries, video and danmaku rendered together, and the remote paused playback. No production comment was posted or deleted: mutation and retry behavior was verified with controlled fixtures. Physical tvOS26 execution and old-system runtime have not been tested.

The desktop default catalog and its SSim/Krig/RAVU shader files are bundled unchanged. A separate TV-only lightweight tier uses the existing RAVU lite shader, bilinear scalers and no debanding. It preserves the selected tier while reducing the effective tier for the current episode if measured video FPS stays at 48+ or rendering keeps missing its frame budget. The render-drop guard ignores five seconds of load/seek warmup and requires two consecutive two-second windows averaging at least two render drops per second. Pause, cache stalls, decoder drops, counter resets and timeline discontinuities reset its observation window. It retries enhancement on a new file or explicit quality selection, never oscillates automatically, and does not override the explicitly selected full desktop preset. Their execution depends on source/output dimensions. Actual A12/4K testing found substantial render drops with the full chain; decoder drops stayed zero and cache stayed full. The full-resolution low-cost scaling comparison kept its 3840×2160 drawable and recorded zero render/decoder drops through 110.652 seconds with danmaku enabled; this is a sampled HEVC 1080p episode, not an all-media performance guarantee. Native TV quality uses this lower-cost scaling by default, while the unchanged full desktop preset remains selectable. Do not infer smooth performance merely from successful shader attachment. Explicit diagnostic launches can write an allowlisted `Library/Caches/tv-playback-probe.json`; normal launches do not write it, and the file reports selected/effective quality, actual drawable size, scalers, frame-drop counters, measured source FPS, rendering options and render-pass timings. URLs, headers, titles and account data are excluded.

This client supports original direct-play/direct-stream media; it does not start transcoders or open live-TV sessions. Offline downloads, multiple profiles, public account registration, moderation/admin controls, audio-track selection and full desktop feature parity remain outside this increment. Playback errors and inaccessible servers are shown with retry paths. Final stop-progress delivery is best effort if the network disappears or the system suspends the app.
