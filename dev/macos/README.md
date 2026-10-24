# 在 macOS 15+ 构建 Tigerest Theater

本工程支持 Apple Silicon 与 Intel macOS 15+。本地脚本按当前机器架构构建；GitHub Actions 工程分别使用 macOS 15 arm64（`macos-15`）与 x86_64（`macos-15-intel`）runner。

## 快速开始

```sh
dev/macos/setup.sh
dev/macos/build.sh
dev/macos/test.sh
dev/macos/run.sh
dev/macos/bundle.sh
```

依赖包括 Xcode Command Line Tools、Homebrew、CMake、Ninja、create-dmg、Node.js、mpv、aqtinstall 和 Qt 6.9.3（含 WebEngine、WebChannel、Positioning）。所有 CMake 入口均将最低部署目标设为 macOS 15.0，`Info.plist` 的 `LSMinimumSystemVersion` 跟随 `CMAKE_OSX_DEPLOYMENT_TARGET`。

安装包会原样带上 Homebrew 的媒体库（FFmpeg、libplacebo、libass 等），而 Homebrew bottle 的最低系统就是构建机的 macOS 版本。因此要发布给 macOS 15 的安装包，必须在 macOS 15 上构建；在更新的 macOS 上打出的包会在 macOS 15 启动时被 dyld 以 `Symbol not found` 终止。`tests/test_macos_bundle.py` 会检查包内每个 Mach-O 的最低系统，超过 `LSMinimumSystemVersion` 时停止打包。只在本机使用的开发包可设置 `MACOS_DEPLOYMENT_TARGET=<本机版本>` 再运行 `build.sh`。

输出位置：

- 开发应用：`build/src/Tigerest Theater.app`
- 完整应用：`build/output/Tigerest Theater.app`
- DMG：`build/TigerestTheater-<version>-<arch>.dmg`

常用检查：

```sh
sh -n dev/macos/*.sh
ctest --test-dir build --output-on-failure
codesign --verify --deep --strict "build/output/Tigerest Theater.app"
python3 tests/test_macos_bundle.py "build/output/Tigerest Theater.app"
```

打包时会包含原生 GPU-Next 播放所需的 MoltenVK 驱动和相对路径 ICD 发现文件。缺少 Homebrew `molten-vk` 依赖时会停止打包，避免生成只能在构建机播放的安装包。

日志位于 `~/Library/Logs/Tigerest Theater/profiles/<profile-id>/`。开发构建若遇到图形兼容问题，可运行 `dev/macos/run.sh --software-rendering`。

没有 macOS runner 时，只能对脚本、CMake、Info.plist、依赖闭包和 CI 定义做静态可复现性检查，不能据此声称已经在 macOS 实机编译或运行。

空格与双击暂停的实机回归测试会打开真实 macvk 播放窗口，分别检查启用和关闭 UOSC 时的暂停、恢复、按键重复和媒体库窗口隔离。它需要可用的图形桌面和 Vulkan/Metal，默认不加入无界面的 CI 测试；在 Mac 本机启用并运行：

```sh
cmake -S . -B build -DENABLE_MACOS_NATIVE_INPUT_TEST=ON
cmake --build build --target test_macos_pause
dev/macos/test.sh -R test_macos_pause
```
