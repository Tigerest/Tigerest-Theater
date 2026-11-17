#!/usr/bin/env sh
# Tigerest Theater - macOS build script
# Run setup.sh first to install dependencies
set -eu

SCRIPT_DIR="$(cd "$(dirname "${0}")" && pwd)"
. "${SCRIPT_DIR}/common.sh"

QTROOT="${DEPS_DIR}/qt/${QT_VERSION}/macos"

# Check dependencies
if [ ! -d "${QTROOT}" ]; then
    echo "error: Qt not found at ${QTROOT}" >&2
    echo "Run setup.sh first" >&2
    exit 1
fi

if ! command -v mpv > /dev/null; then
    echo "error: mpv not found. Run setup.sh first" >&2
    exit 1
fi

echo "Using Qt: ${QTROOT}"

# Build the same pinned streaming runtime as release CI.
RIFE_BUILD="${PROJECT_ROOT}/build/rife"
RIFE_PYTHON="${RIFE_BUILD}/venv/bin/python"
if [ ! -x "${RIFE_PYTHON}" ]; then
    "$(brew --prefix python@3.13)/bin/python3.13" -m venv "${RIFE_BUILD}/venv"
fi
"${RIFE_BUILD}/venv/bin/pip" install meson==1.9.2
"${RIFE_BUILD}/venv/bin/pip" install --require-hashes --only-binary=:all: --no-deps \
    -r "${SCRIPT_DIR}/rife/requirements-runtime.txt"
RIFE_MODEL=""
if [ "$(uname -m)" = arm64 ]; then
    "${RIFE_BUILD}/venv/bin/pip" install -r "${SCRIPT_DIR}/rife/requirements-build.txt"
    "${RIFE_PYTHON}" "${SCRIPT_DIR}/rife/prepare_model.py" "${RIFE_BUILD}/source"
    RIFE_MODEL="${RIFE_BUILD}/models/1080-split-refine"
    if [ ! -f "${RIFE_MODEL}/manifest.json" ]; then
        "${RIFE_PYTHON}" "${SCRIPT_DIR}/rife/split_model.py" \
            --source "${RIFE_BUILD}/source" --output "${RIFE_MODEL}" \
            --width 1920 --height 1080 --grid-scale 0.5 --offload-refine
    fi
    if [ ! -d "${RIFE_MODEL}/Stage3.mlpackage" ]; then
        "${RIFE_PYTHON}" "${SCRIPT_DIR}/rife/coarse_model.py" \
            --source "${RIFE_BUILD}/source" --output "${RIFE_MODEL}" \
            --width 1920 --height 1080
    fi
fi
"${RIFE_PYTHON}" "${SCRIPT_DIR}/rife/build_mpv.py" --output "${RIFE_BUILD}/playback" \
    --meson "${RIFE_BUILD}/venv/bin/meson" --vapoursynth-python "${RIFE_PYTHON}" \
    --deployment-target "${MACOS_DEPLOYMENT_TARGET}"

# Configure
mkdir -p "${BUILD_DIR}"
cd "${BUILD_DIR}"

echo "Configuring..."
cmake -G Ninja \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_OSX_DEPLOYMENT_TARGET="${MACOS_DEPLOYMENT_TARGET}" \
    -DCMAKE_INSTALL_PREFIX=output \
    -DQTROOT="${QTROOT}" \
    -DCMAKE_PREFIX_PATH="${QTROOT}" \
    -DCHECK_FOR_UPDATES=ON \
    -DUSE_STATIC_MPVQT=ON \
    -DMPV_LIBRARY_mpv="${RIFE_BUILD}/playback/mpv-build/libmpv.dylib" \
    -DTIGEREST_RIFE_MODEL_DIR="${RIFE_MODEL}" \
    -DTIGEREST_VAPOURSYNTH_PYTHON="${RIFE_PYTHON}" \
    "${PROJECT_ROOT}"

# Build
echo "Building..."
ninja

echo ""
echo "Build complete!"
echo "App bundle: ${BUILD_DIR}/src/${APP_NAME}"
