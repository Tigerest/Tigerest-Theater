#!/usr/bin/env sh
# Tigerest Theater - macOS bundling script
# Run build.sh first
set -eu

SCRIPT_DIR="$(cd "$(dirname "${0}")" && pwd)"
. "${SCRIPT_DIR}/common.sh"

# Check build exists
if [ ! -d "${BUILD_DIR}/src/${APP_NAME}" ]; then
    echo "error: Build not found. Run build.sh first" >&2
    exit 1
fi

cd "${BUILD_DIR}"

# Install (runs macdeployqt to bundle Qt frameworks)
echo "Bundling Qt frameworks..."
ninja install

APP_BUNDLE="${BUILD_DIR}/output/${APP_NAME}"

# The Qt SDK's stock WebEngine limits the web UI to 60 Hz on macOS. Releases
# carry the display-link engine from a verified bundle (dev/macos/qt/README.md).
if [ -n "${TIGEREST_PATCHED_WEBENGINE_SOURCE:-}" ]; then
    python3 "${PROJECT_ROOT}/dev/macos/use_patched_webengine.py" \
        --source "${TIGEREST_PATCHED_WEBENGINE_SOURCE}" --bundle "${APP_BUNDLE}"
else
    echo "warning: stock Qt WebEngine bundled; the web UI is limited to 60 Hz." >&2
    echo "         Set TIGEREST_PATCHED_WEBENGINE_SOURCE to a verified patched bundle for releases;" >&2
    echo "         tests/test_macos_bundle.py rejects an arm64 bundle without it unless" >&2
    echo "         TIGEREST_ALLOW_STOCK_WEBENGINE=1 (local non-release bundles only)." >&2
fi

echo "Signing app bundle..."
python3 "${PROJECT_ROOT}/dev/macos/sign_bundle.py" "${APP_BUNDLE}"
python3 "${PROJECT_ROOT}/tests/test_macos_bundle.py" "${APP_BUNDLE}"

echo "Creating DMG..."
VERSION="$(cat "${PROJECT_ROOT}/VERSION")"
ARCH="$(uname -m)"
DMG_NAME="TigerestTheater-${VERSION}-${ARCH}.dmg"
rm -f "${DMG_NAME}"
create-dmg \
    --volname "Tigerest Theater v${VERSION}" \
    --no-internet-enable \
    --window-size 500 300 \
    --icon-size 100 \
    --icon "Tigerest Theater.app" 125 150 \
    --app-drop-link 375 150 \
    "${DMG_NAME}" "${APP_BUNDLE}"

echo ""
echo "Bundle complete!"
echo "DMG: ${BUILD_DIR}/${DMG_NAME}"
