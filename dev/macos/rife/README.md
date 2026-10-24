# RIFE development tools

These tools build and verify the bundled model; they are not required on users’ machines.

Use the pinned `requirements-build.txt` in an isolated Python environment. `prepare_model.py` verifies the source and weights against `model_source.json`; `convert_model.py` and `split_model.py` write model manifests and reference fixtures. Generated environments, models and benchmark reports belong in ignored `build/rife/`.

The selected experimental pipeline is `split-coarse-metal` with `cpu-ane`: Encoder and Refine use Core ML’s CPU/Neural Engine configuration, four FP32 coarse convolution stages use CPU/GPU, and spatial warping/resizing/packing uses fused Metal kernels. Actual device execution and full playback performance require separate qualification; configuration names do not prove Neural Engine execution. The monolithic GPU path remains available for comparison.

## Streaming integration

The native plugin requires VapourSynth 79 headers. The included script preserves original YUV samples, validates SDR metadata before conversion, and performs only 2× interpolation at up to 30 input fps. Unknown color, HDR, interlacing and detected VFR bypass inference.

mpv must include the VapourSynth 74+ API compatibility change and `mpv-eof-aware.patch`. The new `vapoursynth:eof-aware=yes` option gives the adapter one-frame lookahead, a reliable last-frame marker, standard color properties, a pre-guess source-color completeness marker, and a nominal final-frame duration when the decoder omits it. Existing VapourSynth filters keep their default behavior. The RIFE controller must use a bounded buffer and concurrent-frames=2.

Configure these CMake cache variables to run the actual-model streaming tests:

- `RIFE_TEST_MODEL_ROOT`: prepared model root, including `128-fp32`, `1080-split-refine` and `1080-grid-half-fp32`.
- `RIFE_TEST_VS_PYTHON`: Python interpreter containing VapourSynth 79.
- `RIFE_TEST_MPV`: test mpv with the EOF patch.
- `RIFE_TEST_VSSCRIPT_LIB`: matching `libvsscript.dylib`.

Build `tigerest_rife_vs` and the native `test_rife_*` targets, then run `ctest -R '^test_rife_' --output-on-failure` in the build directory. The tests use temporary clips and private IPC sockets; they must not connect to an installed player’s SVP endpoint.

The model inference code runs natively. The embedded Python bridge only coordinates VapourSynth nodes and metadata. Full installation closure, application control and performance qualification are separate from plugin correctness.

## Portable macOS package

Use Xcode's toolchain (set `DEVELOPER_DIR` to Xcode-beta on the beta host). `build_mpv.py` downloads and verifies mpv 0.41.0, applies the included API/EOF patches and sets both C/Objective-C and Swift deployment targets to `--deployment-target` (macOS 15.0 by default). It refuses to reuse a source tree with different patch provenance. The Homebrew libraries it links against are copied into the bundle, so they carry the build machine's macOS as their minimum; build release packages on the deployment-target macOS.

`dev/macos/build.sh` prepares the pinned model and playback runtime. CMake accepts `TIGEREST_RIFE_MODEL_DIR` pointing to the verified split packages and `MPV_LIBRARY_mpv` pointing to the resulting library. Installation compiles Encoder/Stage0–3/Refine into `Contents/Resources/rife/model`; development fixtures, PyTorch and conversion tools are excluded. The runtime recipe is verified against VapourSynth R79 and records Python/VS versions in its manifest.

`dev/macos/sign_bundle.py` removes development rpaths, signs leaf code and then containers. `tests/test_macos_bundle.py` checks the model manifest, dependency closure, signatures' prerequisites and isolated Python/VS registration. For actual relocated playback, run `tests/test_rife_portable.py APP TEST_RIFE_CONTROLLER_LIVE`: it makes a disposable copy with Chinese/spaces in the path, adds a temporary native test probe, runs the bundled split pipeline with a clean environment, verifies loaded-library paths, and checks that playback has not changed the signed bundle. The probe is never included in the delivered app.
