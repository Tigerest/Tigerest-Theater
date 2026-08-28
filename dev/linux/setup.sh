#!/usr/bin/env bash
# Jellyfin Desktop - Linux dependency installer
# Run once (Debian/Ubuntu) before build.sh.
#
# Installs everything listed under Build-Depends in ../../debian/control,
# then installs the runtime QML plugins the app imports (Qt.labs.platform,
# WebEngine, etc.).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${0}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

if ! command -v apt-get >/dev/null; then
	echo "error: apt-get not found. This script targets Debian/Ubuntu." >&2
	echo "See ${PROJECT_ROOT}/debian/control for the full dependency list." >&2
	exit 1
fi

echo "Installing build tooling (devscripts, equivs, ninja-build)..."
sudo apt-get update
sudo apt-get install --yes devscripts equivs ninja-build

echo "Installing build dependencies from debian/control..."
sudo mk-build-deps -i -r -t "apt-get --yes" "${PROJECT_ROOT}/debian/control"

echo "Installing runtime QML modules..."
sudo apt-get install --yes \
	qml6-module-qtwebengine \
	qml6-module-qtwebchannel \
	qml6-module-qtquick-controls \
	qml6-module-qtquick-window \
	qml6-module-qtqml-workerscript \
	qml6-module-qtquick-templates \
	qml6-module-qt-labs-platform

echo ""
echo "Setup complete. Run build.sh to build."
