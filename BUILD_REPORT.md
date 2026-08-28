# Tigerest Theater 构建报告

生成时间：2026-08-29（Asia/Shanghai）
最终候选版本：Windows x64 2.0.10-dev

## 结论

Windows x64 2.0.10-dev 已完成实际编译、CTest、Qt 运行库部署、安装器和便携 ZIP 生成。便携包已在全新临时目录解压，`portable` 标记存在；构建目录、安装器 staging、便携 staging 与解压目录中的主程序大小及 SHA-256 完全一致。macOS 没有 runner，本报告不声称 macOS 实机构建、安装或运行。

## Windows 构建环境

| 项目 | 版本/结果 |
| --- | --- |
| 操作系统 | Windows 11 专业工作站版 10.0.22631（Build 22631） |
| 架构 | x64 |
| MSVC | 19.44.35228，v143 x64 |
| Windows SDK | 10.0.26100.0 |
| Qt | 6.9.3，MSVC 2022 x64，含 WebEngine/WebChannel/Positioning |
| CMake | 4.4.2 |
| Ninja | 1.13.0.git.kitware.jobserver-pipe-1 |
| libmpv | v0.41.0-920-gdd5d17d32 |
| Inno Setup | 6.7.3 |
| 构建类型 | RelWithDebInfo |

构建依赖位于独立的 `D:\CodexDeps\TigerestTheater\deps`，未使用已安装客户端作为构建输入。

## 自动化测试

| 测试 | 结果 |
| --- | --- |
| `test_systemcomponent` | 通过，0.12 秒 |
| `test_log` | 通过，0.12 秒 |
| `test_settings` | 通过，0.12 秒 |
| `test_displaymanager` | 通过，0.12 秒 |
| `test_windowmanager` | 通过，0.49 秒 |
| `test_bundle_integrity` | 通过，1.47 秒，9 项检查 |
| `test_player_lifecycle` | 通过，0.05 秒 |
| CTest 总计 | 7/7 通过，2.49 秒 |

## 最终产物

| 产物 | 大小（字节） | SHA-256 |
| --- | ---: | --- |
| `build/TigerestTheater-2.0.10-dev-x64.exe` | 222,840,320 | `0BE6D37A011160514C87E62E46C3EB2B569ECCF30E710CA193475DCFC60763B8` |
| `build/TigerestTheater-2.0.10-dev-x64.zip` | 285,973,509 | `8797B9DF54FB3B6100A77C6542ED7396C6E01FDFDA29958E43CB28C33E8A3535` |
| `build/output/Tigerest Theater.exe` | 84,676,608 | `32CF05FBD3984D9248B62C5F8AF08C22F9514B1A24D5F21D1B322C040AE9984F` |
| 便携 ZIP 解压后的 `Tigerest Theater.exe` | 84,676,608 | `32CF05FBD3984D9248B62C5F8AF08C22F9514B1A24D5F21D1B322C040AE9984F` |

安装器和便携 ZIP 都来自同一 `build/output/Tigerest Theater.exe`。便携包的干净目录解压与标记检查通过。

## 2.0.10 构建内容

- 显式停止和 UOSC/Esc 取消现在向 Emby 上报 `playNext=false`、`resetPlayQueue=true`，不再把返回媒体库解释成“播放下一集”；自然播完仍保留正常连播。
- mpv 的 `MBTN_LEFT_DBL` 显式设为 `ignore`，暂停切换只由 Qt 宿主执行一次，同时屏蔽 mpv 默认的双击全屏动作。
- 退出播放按钮从底部控制栏移到 UOSC 左上角，直接执行 `stop`；不再使用会终止嵌入式 mpv 核心的 `quit`。
- 生命周期测试新增取消、显式停止与自然结束三种停止信息断言；资源完整性测试新增双击单路径和左上角退出按钮契约。
- 继承 2.0.9 的原子 `loadfile replace`、具名信号连接、幂等清理、30 秒启动超时、双后端合成与窗口状态恢复修复。

`windeployqt` 对未使用的 Qt Positioning NMEA 插件提示可选 `Qt6SerialPort` 依赖；主程序、WebEngine、libmpv、VC 运行库和实测播放不受影响。

## macOS 可复现工程

- 最低目标为 macOS 15.0，CMake、`Info.plist`、本地脚本与 CI 参数保持一致。
- 工程包含 arm64/x86_64 分架构构建、Qt 6.9.3、Homebrew mpv、CTest、临时签名和 DMG 打包步骤。
- `test_bundle_integrity` 检查部署目标、`Info.plist`、CI 矩阵与 CTest 声明。

限制：当前主机为 Windows 且没有 macOS runner，未生成 DMG，也未声称 macOS 实机构建、签名、安装、播放或性能验证。
