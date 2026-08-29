# Tigerest Theater 测试报告

生成时间：2026-08-29（Asia/Shanghai）
最终候选版本：macOS arm64 2.0.11-dev；保留 Windows x64 2.0.10-dev 历史结果

## 结论

2.0.11-dev 已在 Apple Silicon Mac 上完成 Release 实际编译、7 项 CTest、完整应用部署、临时签名、DMG 生成与校验，以及真实媒体播放回归。测试使用本机既有登录会话，但没有记录或提交账号与令牌。

2.0.10-dev 的 Windows 实际编译、7 项 CTest、安装版和便携版打包及便携 ZIP 一致性结果仍保留为历史验证。本轮没有重新执行 Windows 构建。

历史版本已完成登录、浏览、在线播放、字幕、跳转、下载、本地回放、GPU-Next、UOSC、Stats、shader 与覆盖安装验收。2.0.9 的新增自动化覆盖单次会话终止、连续新建播放任务、自然结束、取消、停止、销毁、启动超时契约，以及窗口化、最大化和预先全屏三类窗口恢复状态。

macOS 本机实测系统为 27.0 arm64。工程、主程序 Mach-O、Info.plist 与 CI 现已统一以 macOS 26.0 为最低目标，与当前 Homebrew 媒体依赖的兼容性边界一致。

## 自动化、构建与安装

| 检查 | 最终结果 |
| --- | --- |
| Windows 2.0.10 CTest | 7/7 通过，总耗时 2.49 秒 |
| macOS 2.0.11 CTest | 7/7 通过，总耗时 5.39 秒 |
| macOS Release 编译 | 通过，arm64 主程序生成成功 |
| macOS 应用部署与签名 | 通过，断链的 4 个未使用可选插件已剔除，`codesign --verify --deep --strict` 通过 |
| macOS DMG | 通过，310,001,968 字节，SHA-256 `2bcd993292213b1097c54252fe975e2f8bddd3c14a6fa9c9d076aa8da151d12f`，`hdiutil verify` 通过 |
| macOS GUI 与播放 | 通过；真实媒体播放、单窗口、mpv 全屏进入/退出、停止、再次播放和正常关闭均实测 |
| `test_systemcomponent` | 通过（0.65 秒） |
| `test_log` | 通过（0.47 秒，含冒号请求头与 Bearer 脱敏） |
| `test_settings` | 通过（0.47 秒，含 macOS 渲染后端策略） |
| `test_displaymanager` | 通过（0.52 秒） |
| `test_windowmanager` | 通过（0.52 秒） |
| `test_bundle_integrity` | 通过（2.71 秒，9 项完整性、启动遮罩与凭据检查） |
| `test_player_lifecycle` | 通过（0.04 秒） |
| Windows 编译与打包 | 通过，安装器和便携 ZIP 均重新生成 |
| 便携干净目录检查 | ZIP 解压成功、`portable` 标记存在，主程序 SHA-256 与 `build/output` 一致 |

`windeployqt` 仍提示未使用的 Qt Positioning NMEA 插件缺少可选 `Qt6SerialPort`；主程序、WebEngine、libmpv 与实际播放不受影响。

macOS 的 `macdeployqt` 也会发现同类可选插件；本轮打包逻辑会在依赖闭包和签名前剔除 NMEA、Mimer、ODBC 与 PostgreSQL 插件，最终应用包不再保留这些断链 Mach-O。

## 2.0.7 MPV / Shader 实测

| 项目 | 实测结果 |
| --- | --- |
| 档位范围 | UOSC 菜单、设置页和快捷键仅保留默认、真人、激进测试；旧 safe/off/普通动画档已删除并迁移。 |
| Alt+1 默认 | OSD 与 IPC 均确认 3 个非空 shader：SSimDownscaler、KrigBilateral、RAVU Zoom R3。 |
| Alt+2 真人 | OSD 确认 2 个非空 shader：SSimDownscaler、RAVU Zoom R3。 |
| Alt+3 激进测试 | OSD 与 IPC 确认 4 个非空 shader；实际列表包含 SSimDownscaler、Anime4K Restore CNN UL、Anime4K Upscale CNN x2 UL、Anime4K Thin HQ。 |
| 切档可靠性 | 每次先清空列表再应用目标 profile；mpv 的空字符串哨兵不计入 shader 数量，未发生跨档累加。 |
| GPU-Next | IPC 返回 `vo=gpu-next`，画面与声音正常；没有回退为 HTML 播放器。 |
| SVP / IPC | Windows 内置模式返回 `input-ipc-server=mpvpipe`；同一播放会话仍由 libmpv 控制，`vf` 中存在 SVP 链，Emby 页面进度继续更新。 |
| 字幕 | 运行时为 Segoe UI、1.4 倍、ASS 不覆盖、描边 0.5、阴影 0.5、下边距 30；`v` 后 `sub-visibility` 从 true 变为 false，再次按键恢复 true。 |
| 跳转 | 右方向键后 `time-pos` 从 556.6 秒推进到 584.8 秒并继续播放。 |
| 弹幕记忆 | 历史文件保存 `show_danmaku=true`；退出后重新打开播放器仍恢复为开启。 |
| 播放退出 | 返回后详情页只有一份正常内容，未复现 WebEngine 卡片/章节重复平铺。 |
| 配置注释 | 模板内每一条有效 mpv 指令前都有中文说明；用户覆盖文件位于配置末尾，升级不覆盖。 |

条件 shader 只有满足输入/输出缩放条件时才会出现在 Stats 的执行 Pass 中，因此验收同时核对非空 shader 列表、GPU-Next 帧流水线和 OSD 精确计数，不只依据肉眼锐度变化。

## 2.0.8 回归实测

| 问题 | 实测结果 |
| --- | --- |
| 安装器大标志 | 重新生成安装器欢迎页；Tigerest 图形与字标按黑色侧栏宽度居中，未再向一侧偏移。 |
| 播放器交互 | 嵌入式 `gpu-next` 播放时，IPC 的 `mouse-pos.hover` 由 false 变为 true；UOSC 右键菜单可打开，时间轴点击可跳转。 |
| 全屏与键盘 | F11 在 1283×751 窗口与 2560×1440 全屏间切换；空格可暂停/继续，Esc 停止后正常返回详情页。 |
| 剧集横向拖动 | 在详情页用鼠标横向拖动，列表从第 5～8 集区域移动到第 2～6 集区域；随后点击第 3 集，详情更新为 `S1:E3`。 |
| 音频恢复 | 测试时系统默认 E2x2 设备被其他程序独占，mpv 返回 `AUDCLNT_E_DEVICE_IN_USE` 并进入空输出；新逻辑暂停并显示未被 UOSC 过滤的完整设备菜单。选择可用的 Voicemeeter 设备后，`current-ao=wasapi`，48 kHz 双声道参数有效，恢复继续播放。 |
| 启动画面 | 本地连接阶段资源已替换为透明 Tigerest 字标；服务器自行配置的 Emby 页面品牌不属于启动闪屏资源。 |
| 播放退出 | 退出后只有一份详情页 DOM，未再出现人物、章节和剧集卡片重复堆叠。 |

## 2.0.9 播放器生命周期回归

| 检查 | 结果 |
| --- | --- |
| 双击暂停 | 静态契约确认左键双击只发送一次 `cycle pause`，额外释放事件被吞掉；右键、滚轮和 UOSC 路由保持不变。 |
| 连续播放 | JS 会话测试连续执行取消、自然结束、`stop(false)`、停止并销毁后重新播放；信号始终只有一份连接，原生 `stop()` 每个会话最多一次。 |
| 终止路径 | 取消、自然结束、停止、错误、销毁和 30 秒超时都关闭加载状态、移除播放容器并结束窗口会话。 |
| 原子加载 | 完整性检查确认单媒体使用 `loadfile replace`，队列继续使用 `append-play`，不再组合 `stop + append-play`。 |
| 窗口恢复 | 原生 Qt 测试确认窗口化/最大化进入播放全屏后恢复原状态，播放前已全屏则保持全屏。 |
| 页面合成 | GPU-Next 的 WebEngine 持续合成且仅禁用输入；libmpv Render API 播放时隐藏网页避免遮挡。退出不再使用 180 ms 恢复定时器。 |
| 双后端契约 | 完整性测试同时检查 GPU-Next 原生宿主几何/输入链和 libmpv Render API 兼容保护。 |
| 打包一致性 | 安装版和便携版内嵌同一主程序；便携 ZIP 在全新目录解压后 SHA-256 一致。 |

本轮 Windows 图形点击自动化控制内核无法创建，因而没有把“连续人工双击 20 次”和两种后端的肉眼画面检查写成已执行；可自动验证的行为已由 Qt、Node 和静态资源回归覆盖。

## 2.0.10 取消播放与双击回归

| 检查 | 结果 |
| --- | --- |
| 退出后自动续播 | 2.0.9 运行日志确认原生 `canceled` 后 Emby 默认执行 `nextTrack()`；新生命周期测试确认取消和显式停止均发送 `playNext=false`、`resetPlayQueue=true`。 |
| 自然连播 | 自然 `finished` 的停止信息不携带禁止续播标记，继续保留 Emby 的队列自动前进语义。 |
| 双击暂停 | 2.0.9 运行日志确认同一双击在约 270 ms 内先后写入 `pause=true` 和 `pause=false`；2.0.10 将 mpv 绑定改为 `MBTN_LEFT_DBL ignore`，只保留 Qt 宿主的一次 `cycle pause`。 |
| 左上角退出 | UOSC 资源契约确认 `top_bar_controls=left`，左上角 `exit_to_app` 按钮执行 `stop`；底部旧按钮和 `quit` 行为已移除。 |
| 打包一致性 | 安装版、便携 staging 和全新解压目录中的主程序 SHA-256 均为 `32CF05FBD3984D9248B62C5F8AF08C22F9514B1A24D5F21D1B322C040AE9984F`。 |
| 凭据 | 9 项完整性检查覆盖源代码与报告；另对全新解压的便携包扫描精确 Emby/Jellyfin 令牌模式和字面测试账号，命中均为 0。 |

Windows 图形点击自动化组件本轮仍因本机内核资源路径缺失而无法初始化，因此没有把鼠标肉眼验收写成已执行；上述结果来自用户复现日志、Node 生命周期测试、C++/Python 回归与全新便携包一致性检查。

## 2.0.11 macOS 单窗口与退出回归

| 检查 | 结果 |
| --- | --- |
| 渲染后端 | macOS 的 `auto`、`gpu-next`、`libmpv` 三种存量设置都选择 libmpv Render API；Windows 的原生 GPU-Next 选择逻辑不变。 |
| 播放窗口 | 真实媒体播放期间辅助功能树只有 1 个 `Tigerest Theater / 大河影院` 标准窗口，未再创建或拉起独立 mpv Cocoa 窗口。 |
| UOSC 全屏 | 通过 mpv 命令设置 `fullscreen=yes/no` 后，宿主 `isFullScreen()` 分别返回 true/false；全屏始终属于同一个主窗口。 |
| 键盘全屏 | 播放期间连续两次 F11 分别进入和退出主窗口全屏。 |
| 播放退出 | 复用 Windows 2.0.11 的语义，UOSC 等价 `stop` 命令被 libmpv 接受，进入 `canceled`，Emby 收到 `onPlaybackStopped`，应用仍在运行且未自动续播。 |
| 应用退出 | 停止播放后 `Command+Q` 正常退出，进程退出码为 0。 |
| 启动画面 | WebEngine 首帧准备期间显示深色 Tigerest 图标遮罩，不再直接暴露服务器蓝色加载画布。 |

## 核心流程验收边界

| 项目 | 结果 |
| --- | --- |
| 登录 | 历史版本已完成真实登录验收；本轮不提交或记录测试账号。 |
| 浏览 | 首页、媒体库、详情页、剧集横向拖动与选集可用。 |
| 在线播放 | 2.0.8 Windows GPU-Next 画面、UOSC、跳转、全屏和 WASAPI 输出链正常；2.0.11 macOS Render API 真实播放、UOSC 同源全屏与停止路径通过。 |
| 字幕与跳转 | 2.0.7 字幕切换实测通过；2.0.8 重新实测 UOSC 时间轴跳转通过，字幕实现本轮未改。 |
| 下载与回放 | 2.0.4 已完成 224.4 MiB 样本下载、本地回放和删除清理；2.0.8 未改动下载实现。 |
| 打包 | 2.0.10 安装器与便携 ZIP 生成成功；便携包全新目录解压和主程序哈希一致性通过。 |

## macOS 与外部条件

- macOS：已在 macOS 27.0（Build 26A5416b）Apple Silicon 实机完成编译、7/7 CTest、打包、签名、DMG 校验和真实播放；使用本机既有会话但未读取、记录或提交凭据。
- 兼容性：工程、CI、主程序 Mach-O 和 `Info.plist` 均以 macOS 26.0 为最低目标；发布包支持范围为 macOS 26+，不声明支持 macOS 15～25。
- 分发：本轮为 ad-hoc 签名，未做 Developer ID 签名或 Apple notarization。
- Emby Connect：未提供独立 Connect 凭据，因此未做真实 Connect 账号绑定；目标服务器直连验收不受影响。
- Windows 已确认范围没有外部服务器或账号权限阻塞。
