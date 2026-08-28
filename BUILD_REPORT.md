# Tigerest Theater 构建报告

生成时间：2026-08-28（Asia/Shanghai）  
最终候选版本：Windows x64 2.0.8-dev

## 结论

Windows x64 2.0.8-dev 已完成实际编译、CTest、Qt 运行库部署、安装器/便携 ZIP 生成、静默覆盖安装和安装目录启动验证。最终安装目录主程序与 `build/output` 的大小及 SHA-256 完全一致。macOS 没有 runner，本报告不声称 macOS 实机构建、安装或运行。

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
| `test_bundle_integrity` | 通过，0.78 秒，9 项检查 |
| CTest 总计 | 5/5 通过，1.26 秒 |

## 最终产物

| 产物 | 大小（字节） | SHA-256 |
| --- | ---: | --- |
| `build/TigerestTheater-2.0.8-dev-x64.exe` | 222,833,783 | `1E5A18118888F9F21E4032AC35BC1885A8C13ACCC8EB213889E322A3D28123CC` |
| `build/TigerestTheater-2.0.8-dev-x64.zip` | 285,969,158 | `539B11F2C6AFAA5C4A0DC5BCA39B236B932401BD5ACB27EF1BF17CDB149BA873` |
| `build/output/Tigerest Theater.exe` | 84,675,584 | `74D78A7666E9D1C956877F6A5D17647905BF9F3796D6E72D210DFA4B7995FC7E` |
| 安装目录 `Tigerest Theater.exe` | 84,675,584 | `74D78A7666E9D1C956877F6A5D17647905BF9F3796D6E72D210DFA4B7995FC7E` |

安装目录为 `%LOCALAPPDATA%\Programs\Tigerest Theater`。最终安装器静默覆盖退出码为 0；安装后主程序成功启动并加载既有服务器会话。

## 2.0.8 构建内容

- 安装器侧栏大标志改为按画布宽度计算居中位置；重新生成 Windows 安装图、程序图标与 macOS 图标资源。
- 连接阶段使用 Tigerest 透明字标，移除短暂显示 Jellyfin 启动标志的本地资源。
- 原生 mpv 子窗口现在将焦点、鼠标、双击、滚轮和键盘事件送回已有输入命令，UOSC 可交互且不创建第二个 mpv 窗口。
- Emby 剧集横向列表加入桌面鼠标拖动；超过阈值后抑制误点击，普通点击仍可选集。
- 若系统默认音频设备被独占而 mpv 回退到空输出，播放器会暂停并打开不依赖 `current-ao` 过滤的完整设备恢复菜单，避免无声继续播放。
- 内置配置精简为默认、真人、激进测试三档，快捷键固定为 Alt+1 / Alt+2 / Alt+3，目标非空 shader 数为 3 / 2 / 4。
- 默认档采用参考 `anime-aa-insane` 参数；激进档保留可在 Stats 中识别的 Anime4K Restore/Upscale/Thin。
- 配置模板的每条指令增加中文注释；字幕参数同步参考配置并带一次性旧默认迁移。
- Windows 内置配置在 libmpv 初始化前写入 `input-ipc-server=mpvpipe`；macOS 不生成 Windows 命名管道。
- 弹幕开关在 `file-loaded` 时恢复持久化值，并同步 UOSC 开关显示。
- 设置页默认不再覆盖完整 profile；只有显式开启“高级档位覆盖”才应用单项调节。
- 日志清洗支持 libmpv 冒号请求头和 Bearer 头，并在启动时原子迁移现存轮转日志。
- 保留专用原生 mpv 子宿主、GPU-Next、UOSC、F11、完整 Stats 和退出页面隔离修复。

`windeployqt` 对未使用的 Qt Positioning NMEA 插件提示可选 `Qt6SerialPort` 依赖；主程序、WebEngine、libmpv、VC 运行库和实测播放不受影响。

## macOS 可复现工程

- 最低目标为 macOS 15.0，CMake、`Info.plist`、本地脚本与 CI 参数保持一致。
- 工程包含 arm64/x86_64 分架构构建、Qt 6.9.3、Homebrew mpv、CTest、临时签名和 DMG 打包步骤。
- `test_bundle_integrity` 检查部署目标、`Info.plist`、CI 矩阵与 CTest 声明。

限制：当前主机为 Windows 且没有 macOS runner，未生成 DMG，也未声称 macOS 实机构建、签名、安装、播放或性能验证。
