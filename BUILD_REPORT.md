# Tigerest Theater 构建报告

生成时间：2026-08-29（Asia/Shanghai）
最终候选版本：macOS arm64 2.0.11-dev

## 结论

2.0.11-dev 已在 Apple Silicon Mac 上完成 Release 实际编译、7 项 CTest、Qt/libmpv 依赖部署、临时签名、DMG 生成、镜像校验和真实播放验收。使用本机既有登录会话播放媒体后，确认 macOS 只保留一个主窗口，mpv 发出的全屏进入/退出请求均作用于该主窗口，UOSC `stop` 路径返回媒体页且应用保持运行，最后 `Command+Q` 以退出码 0 正常结束；测试没有记录或提交账号与令牌。

最终 DMG 为 `build/TigerestTheater-2.0.11-dev-arm64.dmg`，SHA-256 为 `2bcd993292213b1097c54252fe975e2f8bddd3c14a6fa9c9d076aa8da151d12f`。

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
| `test_systemcomponent` | 通过，0.65 秒 |
| `test_log` | 通过，0.47 秒 |
| `test_settings` | 通过，0.47 秒；含 macOS Render API 平台策略 |
| `test_displaymanager` | 通过，0.52 秒 |
| `test_windowmanager` | 通过，0.52 秒；macOS 使用 Qt offscreen 后端隔离原生窗口管理器异步行为 |
| `test_bundle_integrity` | 通过，2.71 秒，9 项完整性、启动遮罩与凭据检查 |
| `test_player_lifecycle` | 通过，0.04 秒；Node 现为 macOS setup 的显式依赖 |
| CTest 总计 | 7/7 通过，5.39 秒 |

## 打包与运行验收

| 检查 | 结果 |
| --- | --- |
| `ninja install` / `macdeployqt` | 通过；Qt WebEngine、libmpv、SDL2/SDL3 及媒体依赖已部署 |
| 可选插件清理 | 已剔除未使用且断链的 Mimer、ODBC、PostgreSQL SQL 驱动和 NMEA 定位插件 |
| 动态库路径 | 所有 Mach-O 均未引用 `/opt/homebrew`、`/usr/local`、Postgres.app、QtSerialPort、libiodbc 或 libmimerapi |
| 临时签名 | `codesign --verify --deep --strict` 通过 |
| DMG | `hdiutil verify` 通过 |
| GUI 与播放 | 实际播放通过；Render API 在 QML 场景内输出，辅助功能树始终只有 1 个标准窗口 |
| 全屏与退出 | mpv `fullscreen=yes/no`、F11、`stop`、再次播放和 `Command+Q` 均通过；应用正常退出码为 0 |
| 启动过渡 | 深色 Tigerest 图标遮罩覆盖网页首帧空档，不再暴露 Emby 蓝色加载画布 |
| 最新启动日志 | 未发现 `dyld`、应用依赖加载、崩溃或 fatal 标记；本机系统 mpv 配置中的第三方 shader/VapourSynth 警告不属于应用包依赖 |

## 最终产物

| 产物 | 大小（字节） | SHA-256 |
| --- | ---: | --- |
| `build/TigerestTheater-2.0.11-dev-arm64.dmg` | 310,001,968 | `2bcd993292213b1097c54252fe975e2f8bddd3c14a6fa9c9d076aa8da151d12f` |
| `build/output/Tigerest Theater.app/Contents/MacOS/Tigerest Theater` | 69,843,456 | `b659c92ed70041816b123eb60e5e50f463b5038014c97c0dff00401e4b876c31` |

DMG 使用 ad-hoc 签名，适合本机和开发测试；公开分发仍需 Apple Developer ID 签名与 notarization。

## 本轮工程修复

- macOS 脚本补齐可执行权限，README 中的直接运行命令不再报 `permission denied`。
- `setup.sh` 补装 Node.js 与 pkgconf；`test.sh` 会拒绝把缺少生命周期测试的 6 项部分套件误报为完整成功。
- `test_windowmanager` 在 macOS 使用 Qt offscreen 平台，避免非活动测试进程的原生 maximize/fullscreen 请求被系统拒绝。
- macOS 打包剔除 4 个未使用且依赖不完整的可选 Qt 插件，并正确校验已部署的 `@rpath` Qt Framework。
- CMake 使用 CMP0148 NEW；三处 Qt `qsizetype` 到 `int` 的截断警告已消除。
- macOS 不再使用 mpv `wid`/Cocoa 原生子窗口；`auto` 和旧配置中的 `gpu-next` 均落到单窗口 libmpv Render API，Windows 的原生 GPU-Next 路径保持不变。
- 沿用 Windows 2.0.11 的退出生命周期修复：UOSC 退出只发送 `stop`，禁止插件用 `quit` 销毁共享 libmpv 内核，异常 quit 仍按用户取消收尾。
- 启动阶段增加深色 Tigerest 品牌遮罩，避免 WebEngine 首帧前短暂显示服务器蓝色加载画布。

## 兼容性边界

工程、本地构建脚本、GitHub Actions、主程序 Mach-O 与 `Info.plist` 现已统一声明最低 macOS 26.0。本轮 DMG 在 macOS 27 Apple Silicon 实机构建和启动验收，发布范围为 macOS 26+，不再声明或维护 macOS 15～25 兼容性。

## Windows 历史结果

2.0.10-dev 的 Windows x64 安装器、便携 ZIP 和 7/7 CTest 结果保留在测试报告中；2.0.11 源码中的退出生命周期修复已作为本轮 Mac 回归基线，但本轮没有重新构建或改写 Windows 二进制结论。
