# Tigerest Theater 构建报告

生成时间：2026-08-29（Asia/Shanghai）
最终候选版本：Windows x64 2.0.9-dev

## 结论

Windows x64 2.0.9-dev 已完成实际编译、CTest、Qt 运行库部署、安装器和便携 ZIP 生成。便携包已在全新临时目录解压，`portable` 标记存在；构建目录、安装器 staging、便携 staging 与解压目录中的主程序大小及 SHA-256 完全一致。macOS 没有 runner，本报告不声称 macOS 实机构建、安装或运行。

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
| `test_systemcomponent` | 通过，0.15 秒 |
| `test_log` | 通过，0.15 秒 |
| `test_settings` | 通过，0.14 秒 |
| `test_displaymanager` | 通过，0.14 秒 |
| `test_windowmanager` | 通过，0.62 秒 |
| `test_bundle_integrity` | 通过，1.57 秒，9 项检查 |
| `test_player_lifecycle` | 通过，0.04 秒 |
| CTest 总计 | 7/7 通过，2.85 秒 |

## 最终产物

| 产物 | 大小（字节） | SHA-256 |
| --- | ---: | --- |
| `build/TigerestTheater-2.0.9-dev-x64.exe` | 222,838,241 | `BEFF76692F94D10D42BDB6D59318032D976F7197D71A8BEC7B9FFC94F53962AB` |
| `build/TigerestTheater-2.0.9-dev-x64.zip` | 285,971,707 | `E51FBA2E9830DB60B2C8327B0645B6AF1DABCF82DBF77C5ABFEC3B8D9D500B3F` |
| `build/output/Tigerest Theater.exe` | 84,676,608 | `19350913332B7E8C331CD2F1ED9744284FE26E2D61CA3AC976AE976B855814C3` |
| 便携 ZIP 解压后的 `Tigerest Theater.exe` | 84,676,608 | `19350913332B7E8C331CD2F1ED9744284FE26E2D61CA3AC976AE976B855814C3` |

安装器和便携 ZIP 都来自同一 `build/output/Tigerest Theater.exe`。便携包的干净目录解压与标记检查通过。

## 2.0.9 构建内容

- 左键双击由原生输入层直接执行一次 `cycle pause`，并吞掉对应的多余释放事件。
- 单媒体加载改为原子 `loadfile replace`，队列追加继续使用 `append-play`，返回真实命令结果。
- 播放会话信号改为具名连接和统一断开；自然结束、Esc、停止、错误、销毁和 30 秒启动超时均执行幂等清理。
- GPU-Next 下 WebEngine 在原生视频层下持续合成；libmpv Render API 保留播放时隐藏网页的兼容路径。退出同步隐藏视频宿主，不再使用 180 ms 恢复定时器。
- 全屏切换统一由 `WindowManager` 管理，播放结束恢复播放前的窗口化或最大化状态；播放前已全屏则保持全屏。
- Emby 标题栏新增窗口/全屏按钮，UOSC 新增退出播放并返回媒体库按钮。
- 新增播放器生命周期、窗口状态、加载语义、双后端资源契约和凭据安全回归测试。

`windeployqt` 对未使用的 Qt Positioning NMEA 插件提示可选 `Qt6SerialPort` 依赖；主程序、WebEngine、libmpv、VC 运行库和实测播放不受影响。

## macOS 可复现工程

- 最低目标为 macOS 15.0，CMake、`Info.plist`、本地脚本与 CI 参数保持一致。
- 工程包含 arm64/x86_64 分架构构建、Qt 6.9.3、Homebrew mpv、CTest、临时签名和 DMG 打包步骤。
- `test_bundle_integrity` 检查部署目标、`Info.plist`、CI 矩阵与 CTest 声明。

限制：当前主机为 Windows 且没有 macOS runner，未生成 DMG，也未声称 macOS 实机构建、签名、安装、播放或性能验证。
