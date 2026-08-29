# Tigerest Theater 构建报告

生成时间：2026-08-29（Asia/Shanghai）
最终候选版本：macOS arm64 2.0.11-dev

## 结论

2.0.11-dev 已在 Apple Silicon Mac 上完成 Release 实际编译、7 项 CTest、Qt/libmpv 依赖部署、临时签名、DMG 生成、镜像校验和 GUI 首屏启动验收。应用成功连接既有服务器并渲染用户选择页；为避免触碰本机已有账号，本轮没有登录或播放媒体。

最终 DMG 为 `build/TigerestTheater-2.0.11-dev-arm64.dmg`，SHA-256 为 `3ad7bf3e7b2d4c9c6ae7db47b6183d9bb49d00a16eb894bba309836b3ac9e727`。

## macOS 构建环境

| 项目 | 版本/结果 |
| --- | --- |
| 操作系统 | macOS 27.0（Build 26A5416b，预发布版本） |
| 架构 | arm64 / Apple Silicon |
| 编译器 | Apple Clang 21.0.0，Xcode Command Line Tools SDK 27.0 |
| 完整 Xcode | 26.6 已安装；本轮未使用未接受许可的完整 Xcode，使用已激活的 Command Line Tools |
| Qt | 6.9.3，macOS universal，含 WebEngine/WebChannel/Positioning |
| CMake / Ninja | 4.4.3 / 1.13.2 |
| libmpv | Homebrew mpv 0.41.0 |
| Node / Python | Node 26.7.0 / Python 3.14.0 |
| pkg-config / create-dmg | pkgconf 3.0.6 / create-dmg 1.3.0 |
| 构建类型 | Release |
| 工程部署目标 | macOS 26.0 |

依赖位于 Homebrew 与 `dev/macos/deps/qt/6.9.3/macos`；Qt 目录和构建目录均被 Git 忽略，未提交二进制依赖。

## 自动化测试

| 测试 | 结果 |
| --- | --- |
| `test_systemcomponent` | 通过，0.20 秒 |
| `test_log` | 通过，0.13 秒 |
| `test_settings` | 通过，0.14 秒 |
| `test_displaymanager` | 通过，0.14 秒 |
| `test_windowmanager` | 通过，0.15 秒；macOS 使用 Qt offscreen 后端隔离原生窗口管理器异步行为 |
| `test_bundle_integrity` | 通过，3.11 秒，9 项完整性与凭据检查 |
| `test_player_lifecycle` | 通过，0.13 秒；Node 现为 macOS setup 的显式依赖 |
| CTest 总计 | 7/7 通过，4.01 秒 |

## 打包与运行验收

| 检查 | 结果 |
| --- | --- |
| `ninja install` / `macdeployqt` | 通过；Qt WebEngine、libmpv、SDL2/SDL3 及媒体依赖已部署 |
| 可选插件清理 | 已剔除未使用且断链的 Mimer、ODBC、PostgreSQL SQL 驱动和 NMEA 定位插件 |
| 动态库路径 | 所有 Mach-O 均未引用 `/opt/homebrew`、`/usr/local`、Postgres.app、QtSerialPort、libiodbc 或 libmimerapi |
| 临时签名 | `codesign --verify --deep --strict` 通过 |
| DMG | `hdiutil verify` 通过 |
| GUI 首屏 | 实际启动通过；窗口、WebEngine 和服务器用户选择页正常渲染，随后正常退出 |
| 最新启动日志 | 未发现 `dyld`、库加载、插件加载、崩溃或 fatal 标记 |

## 最终产物

| 产物 | 大小（字节） | SHA-256 |
| --- | ---: | --- |
| `build/TigerestTheater-2.0.11-dev-arm64.dmg` | 309,995,783 | `3ad7bf3e7b2d4c9c6ae7db47b6183d9bb49d00a16eb894bba309836b3ac9e727` |
| `build/output/Tigerest Theater.app/Contents/MacOS/Tigerest Theater` | 69,826,800 | `c69b8d674d618fa547a27641787ac08116d96ef1aa21af999f3cd375df8d326d` |

DMG 使用 ad-hoc 签名，适合本机和开发测试；公开分发仍需 Apple Developer ID 签名与 notarization。

## 本轮工程修复

- macOS 脚本补齐可执行权限，README 中的直接运行命令不再报 `permission denied`。
- `setup.sh` 补装 Node.js 与 pkgconf；`test.sh` 会拒绝把缺少生命周期测试的 6 项部分套件误报为完整成功。
- `test_windowmanager` 在 macOS 使用 Qt offscreen 平台，避免非活动测试进程的原生 maximize/fullscreen 请求被系统拒绝。
- macOS 打包剔除 4 个未使用且依赖不完整的可选 Qt 插件，并正确校验已部署的 `@rpath` Qt Framework。
- CMake 使用 CMP0148 NEW；三处 Qt `qsizetype` 到 `int` 的截断警告已消除。

## 兼容性边界

工程、本地构建脚本、GitHub Actions、主程序 Mach-O 与 `Info.plist` 现已统一声明最低 macOS 26.0。本轮 DMG 在 macOS 27 Apple Silicon 实机构建和启动验收，发布范围为 macOS 26+，不再声明或维护 macOS 15～25 兼容性。

## Windows 历史结果

2.0.10-dev 的 Windows x64 安装器、便携 ZIP 和 7/7 CTest 结果保留在测试报告中；本轮 Mac 任务没有重新构建或改写这些 Windows 二进制结论。
