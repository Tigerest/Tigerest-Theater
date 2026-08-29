#!/usr/bin/env sh
# Tigerest Theater - Run unit tests
# Run build.sh first
set -eu

SCRIPT_DIR="$(cd "$(dirname "${0}")" && pwd)"
. "${SCRIPT_DIR}/common.sh"
setup_runtime

cd "${BUILD_DIR}"

# The JavaScript lifecycle regression test is intentionally registered only
# when Node is present at CMake configure time. Refuse to report a partial
# suite as successful when setup.sh was skipped or the build directory is stale.
if ! command -v node > /dev/null; then
    echo "error: Node.js not found. Run setup.sh first" >&2
    exit 1
fi
if ! ctest -N | grep -q "test_player_lifecycle"; then
    echo "error: test_player_lifecycle is not registered. Re-run build.sh after setup.sh" >&2
    exit 1
fi

ctest --output-on-failure "$@"
