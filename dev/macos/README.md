# 在 macOS 15+ 构建 Tigerest Theater

本工程支持 Apple Silicon 与 Intel macOS 15+。本地脚本按当前机器架构构建；GitHub Actions 工程分别声明 arm64 与 x86_64 runner。

## 快速开始

```sh
dev/macos/setup.sh
dev/macos/build.sh
dev/macos/test.sh
dev/macos/run.sh
dev/macos/bundle.sh
```

依赖包括 Xcode Command Line Tools、Homebrew、CMake、Ninja、create-dmg、mpv、aqtinstall 和 Qt 6.9.3（含 WebEngine、WebChannel、Positioning）。所有 CMake 入口均将最低部署目标设为 macOS 15.0。

输出位置：

- 开发应用：`build/src/Tigerest Theater.app`
- 完整应用：`build/output/Tigerest Theater.app`
- DMG：`build/TigerestTheater-<version>-<arch>.dmg`

常用检查：

```sh
sh -n dev/macos/*.sh
ctest --test-dir build --output-on-failure
codesign --verify --deep --strict "build/output/Tigerest Theater.app"
```

日志位于 `~/Library/Logs/Tigerest Theater/profiles/<profile-id>/`。开发构建若遇到图形兼容问题，可运行 `dev/macos/run.sh --software-rendering`。

没有 macOS runner 时，只能对脚本、CMake、Info.plist、依赖闭包和 CI 定义做静态可复现性检查，不能据此声称已经在 macOS 实机编译或运行。
