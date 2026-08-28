# Building Jellyfin Desktop on Linux

## Quick Start

### Setup and build

```bash
dev/linux/setup.sh   # First time: install dependencies (Debian/Ubuntu)
dev/linux/build.sh   # Configure, build, and optionally install
```

## Prerequisites

- **Debian/Ubuntu** (or derivative) with `apt-get`

`setup.sh` installs everything else:

- Build tooling: `devscripts`, `equivs`, `ninja-build`, `cmake`
- Build-time packages from [`../../debian/control`](../../debian/control)'s `Build-Depends`, including the required Qt6 modules (`qt6-base-dev`, `qt6-base-private-dev`, `qt6-declarative-dev`, `qt6-webengine-dev`, `qt6-wayland-dev`), `libmpv-dev`, `libcec-dev`, and the rest of the native toolchain
- Runtime QML plugins from `debian/control`'s `Depends:` field (`qml6-module-qtwebengine`, `qml6-module-qtwebchannel`, `qml6-module-qtquick-controls`, `qml6-module-qtquick-window`, `qml6-module-qtqml-workerscript`, `qml6-module-qtquick-templates`, `qml6-module-qt-labs-platform`), none of these are pulled in transitively by the `-dev` packages above, so they're installed separately

## Install

`build.sh` asks for confirmation separately before each `sudo` step:

1. **Install Binary** @ `/usr/local/bin/jellyfin-desktop`
2. **Desktop integration** (`.desktop` file, icon, appdata metadata) @ `/usr/local/share/{applications,icons,metainfo}/`

Answer `n` to either prompt to skip it. The built binary at `build/src/jellyfin-desktop` still runs without installing.

## Directory Structure

- `build/` - Build output (safe to delete)
- `build/src/jellyfin-desktop` - Built executable

## Scripts

- `setup.sh` - Install build and runtime dependencies
- `build.sh` - Initialize submodules, configure, build, and optionally install

## Clean Build

```bash
rm -rf build
dev/linux/build.sh
```

## Troubleshooting

### Missing Qt6 packages

```
error: Qt6 dev packages not found. Run setup.sh first
```

Run `dev/linux/setup.sh`.

## Notes

- Data/config/cache/log file locations are documented in the [main README](../../README.md#file-locations)
