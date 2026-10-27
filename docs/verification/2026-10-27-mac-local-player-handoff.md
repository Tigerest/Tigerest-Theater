# Mac 接收：本地播放器（2.9.5）

Windows 已在分支 `claude/windows-local-player` 完成本地播放器，作为 2.9.5 的主要更新。共享的 C++ 和网页脚本 Mac 已经自动带上；Mac 需要补上系统层的文件打开，再打开入口开关，然后按下面的清单实测。

## 用户期望

- 用视频文件打开大河影院（「打开方式」、拖到程序图标、命令行），就作为本地播放器直接播放，不需要媒体服务器。
- 本地播放不用任何在线服务：不搜索、不加载弹幕（uosc 里的弹幕按钮隐藏），不上报播放进度，没有评论和一起看。
- 用文件启动时不自动连接上次的服务器；服务器选择页显示「正在作为本地播放器使用……」，用户选服务器才连接。
- 播放列表：单独打开一个文件时，同一文件夹里的视频（24 种扩展名，加上这个文件本身）按文件名自然排序（第 2 集在第 10 集前）成为列表，从这个文件开始，播完接下一个；一次打开多个文件时，列表就是这些文件。uosc 的列表、上一个／下一个、任务栏和媒体键都在这个列表里切换。应用已在运行时再打开文件，交给已有窗口播放。
- 正在播放服务器视频时打开本地文件：先正常停止原播放（进度照常上报），本地文件的播放不记到那个条目上。
- 音轨、字幕交给 mpv 自动选择，同名外挂字幕自动加载。列表最后一个播完或停止后回到服务器选择页；打不开的文件提示「无法播放「文件名」。」并接着播下一个。
- 服务器选择页有「打开本地视频」「打开离线媒体」「设置」；没连服务器时「设置」也能打开完整设置。

## 已共享、Mac 自动带上的部分

| 位置 | 内容 |
| --- | --- |
| `src/system/LocalMedia.{h,cpp}` | 参数/`file:` URL 转文件、去重、自然排序、同文件夹视频（`folderVideos`）、生成播放列表（URL 完整编码，`#`、`%` 不会截断路径）、24 种扩展名、文件对话框过滤器 |
| `SystemComponent` | `openLocalFiles(files, atStartup)` 500 ms 合并一批；`takeLocalFiles()` 返回 `{items, start}`（单个文件展开成同文件夹的列表）、`startedWithLocalFiles()`、`chooseLocalFiles()`（非阻塞 `QFileDialog`，挂在主窗口下）、`localFilesRequested` 信号 |
| `main.cpp` | 位置参数 `[files...]`；单实例消息带 `files`，交给已运行的实例 |
| `PlayerComponent::loadMedia` | metadata 带 `localPlayback: true` 时，`aid`/`sid` 用 `auto`（原来固定 `no`，离线播放因此没有声音和字幕），并设置 mpv 属性 `user-data/tigerest/local-playback` |
| `PlayerComponent` `START_FILE` | mpv 不经过 `loadMedia`、自己换文件时（uosc 文件浏览、脚本 `loadfile`），上一个文件的 `END_FILE` 已隐藏视频窗口，而沿用的 VO 不会再报 `vo-configured` 变化；现在按最后一次的 `vo-configured`（`m_voConfigured`）重新显示。以前这种情况只有声音、画面黑屏 |
| `uosc_danmaku/main.lua`、`uosc.conf` | 本地播放不自动加载弹幕，弹幕菜单入口提示「本地播放不加载弹幕」；弹幕按钮用 `<!user-data/tigerest/local-playback>` 隐藏 |
| `native/localPlayer.js`（新） | 播放列表与当前位置、停止服务器播放、`setVideoOnlyMode`、`beginPlaybackSession`/`endPlaybackSession`、错误提示。列表通过 `setWebPlaylist` 交给 uosc（`local-N` 作为 `PlaylistItemId`），uosc 的选择经 `tigerest-playlist-item` → `hostInput` 的 `playlist-item:local-N` 回到这里加载；`next`/`previous` 动作（任务栏、媒体键）也在列表里切换 |
| `native/offline.js` | 桌面上离线下载改走 `tigerestPlayLocalMedia`；没有 localPlayer.js 的包（Android、iPad）仍按原方式直接加载 |
| `native/inputPlugin.js`、`embycompat.js` | 服务器播放选集：Emby 从剧集页「播放」（NextUp）开始时队列里只有这一集。队列只有一集、且是有 `SeriesId` 的单集时，用 `connectionManager.getApiClient(item).getEpisodes(SeriesId, {SeasonId, …})` 读这一季（去掉 `Virtual`），交给 `setWebPlaylist`：当前集用 Emby 的 `PlaylistItemId`，其他集用 `season-episode:<Id>`。选这些集、`next`/`previous` 动作调用 `playbackManager.play({ids, serverId, fullscreen: true})`；队列多于一集时照旧用 Emby 的队列。Android、iPad 共用这份脚本，原生选集列表也会列出整季 |
| `native/find-webclient.*` | 选择页按钮；带文件启动不自动连接 |
| `native/nativeshell.js` | 独立设置窗口在桌面改为左侧分组菜单（播放器设置在前、媒体库设置在后，窄窗口用分组下拉）；客户端菜单「打开本地视频」；快捷键 |

注意：`localPlayer.js` 在 Mac 上已经注入，`tigerestPlayLocalMedia` 已定义，所以**Mac 的离线媒体播放在这个分支上已经改走本地播放流程**，即使入口还没打开，也要先验这一项。

## Mac 需要补的

1. **文件类型声明：** 在 `bundle/osx/Info.plist.in` 加 `CFBundleDocumentTypes`，`CFBundleTypeRole` 为 `Viewer`，`LSHandlerRank` 用 `Alternate`（与 Windows 只加进「打开方式」、不抢默认播放器一致）。类型覆盖 `LocalMedia::videoExtensions()` 的 24 种扩展名：能用系统 UTI 的用 `LSItemContentTypes`（如 `public.movie`、`public.mpeg-4`、`com.apple.quicktime-movie`、`public.avi`、`public.mpeg-2-transport-stream`），mkv、rmvb 等没有系统 UTI 的需要 `UTImportedTypeDeclarations` 或 `CFBundleTypeExtensions`。
2. **接收打开事件：** macOS 通过 Apple Event 交文件，不走 argv，也不会再启动第二个进程。在 `QApplication` 上处理 `QEvent::FileOpen`（`QFileOpenEvent::file()`），交给 `SystemComponent::Get().openLocalFiles({file}, atStartup)`。
   - 冷启动时事件可能早于 `ComponentManager::initialize()`，要先缓存，初始化后再交出去。
   - 冷启动带来的文件要算作 `atStartup = true`，否则选择页会先自动连接服务器。网页在 `apiPromise` 之后调用 `startedWithLocalFiles()`；需要保证这时启动文件已经登记（比如在主窗口加载网页前处理完启动阶段收到的事件）。
   - Finder 一次打开多个文件会连续发多个事件，500 ms 合并窗口会把它们排成一个队列，不要另做合并。
3. **打开入口开关：** `native/localPlayer.js` 的 `available()` 目前只认 `api.system.isWindows`，Mac 完成以上两项后改为 `isWindows || isMacos`。它控制选择页和客户端菜单的「打开本地视频」以及快捷键。
4. **快捷键：** `nativeshell.js` 里 Ctrl+O 只判断 `event.ctrlKey`；Mac 应该用 ⌘O（`metaKey`），菜单里的快捷键文字也相应显示。设置窗口已有的 `Ctrl+,` 判断同时接受 `metaKey`，可以照着改。
5. **独立视频窗口：** Mac 的视频在单独的 macvk 窗口。实测 `setVideoOnlyMode(true/false)`、`beginPlaybackSession`/`endPlaybackSession` 在本地播放的开始、换下一个文件、播完、停止、出错时都能正确显示和恢复网页，全屏进入后结束播放能恢复。`START_FILE` 按 `m_voConfigured` 重新显示窗口的改动也作用在 Mac 上，要确认 VO 沿用和拆除（`m_nativeVoTeardownPending`）两种情况下窗口都不闪、不黑。
6. **文件对话框：** `chooseLocalFiles()` 用非阻塞的 `QFileDialog::open()`，并设置 `transientParent` 为主窗口；Mac 上确认它作为原生面板出现在大河影院窗口前面，多选、过滤器「视频文件 / 所有文件」可用，取消后不影响播放。

## Mac 验收清单

- 冷启动：Finder 里对视频「打开方式 → 大河影院」，直接播放；选择页没有请求上次保存的服务器（用记录请求的本地 fixture 服务器确认，不用真实服务器地址）。
- 已运行：再打开一个文件，交给同一窗口；Finder 同时选 3 个文件打开，按自然排序依次播放，播完自动接下一个。
- 播放列表：单独打开某一集，uosc 列表列出同文件夹的各集并标出当前集；在列表里选别的集、按上一个／下一个都有画面和声音，标题跟着变；最后一集按「下一个」不动作。
- mpv 属性：`aid`、`sid` 不是 `no`，同名 `.srt` 加载；`user-data/tigerest/local-playback` 为 `true`；日志里没有 `uosc_danmaku: hash`（服务器播放时会有）。
- uosc 控制栏没有弹幕按钮；按弹幕快捷键只显示「本地播放不加载弹幕」。
- 播放服务器视频时打开本地文件：服务器那边收到停止上报，本地文件播放期间没有进度上报。
- 停止、播完、打不开的文件（提示文件名）都回到选择页，再打开文件还能正常播放。
- 离线媒体：下载好的视频有声音和字幕，停止后回到原来的页面。
- 设置：选择页「设置」能打开完整设置；左侧分组菜单可切换，窗口变窄后改成下拉。
- iPad / iPhone 不受影响：离线媒体仍走原生离线库，正常播放。
- 服务器选集：在剧集页点「播放」（继续看下一集），uosc 播放列表列出这一季并标出当前集；选别的集、上一个／下一个都换集且有画面，换集后列表仍能继续选（这一季，或 Emby 排好的多集队列）。iPad 的选集列表同样检查一次。

## Windows 的验证结果

验证使用隔离配置档（独立配置目录和配置档名），没有动用户正在运行的播放器和设置。

- 构建与自动化测试：`test_local_media`（参数解析、排序、URL 编码、过滤器）、`test_systemcomponent`、`test_bundle_integrity`（安装器扩展名与 `LocalMedia` 一致、离线播放回退）、`test_offline_downloads`（含离线播放走本地播放器 / 无本地播放器时直接加载）、`test_settings_webengine`（侧栏分组）、`test_server_picker_webengine`、`test_playback_exit_webengine`、`test_window_startup_webengine` 等全部通过。
- 真实客户端与真实 mpv 播放（fixture 服务器只用来记录是否被请求）：
  - 带文件启动：选择页不自动连接，fixture 服务器始终 0 个请求。
  - mkv：`aid=1`、`sid=1`（外挂 srt），本地播放标记为 `true`；日志里没有弹幕 hash 匹配。
  - 截图确认 uosc 弹幕按钮已隐藏，字幕显示。
  - 第二次启动约 2.1–2.3 s 退出，文件交给已运行的实例播放。
  - 两个进程同时启动，合并为一个队列，播完第一个自动接第二个。
  - 停止和单个文件播完都回到选择页；离线下载播放有声音和字幕；打不开的文件提示文件名。
  - 文件对话框标题为「打开本地视频」，所有者是主窗口；Ctrl+O 能打开。
  - 播放列表（同一文件夹 3 集，另有一个文本文件和子文件夹）：单独打开第 1 集，列表为第 1 集、第 2 集、第 10 集；uosc「下一个」、列表选第 10 集都换到对应一集且有画面，最后一集「下一个」不动作，播完回到选择页；脚本直接 `loadfile` 另一集时画面正常（修复前只有声音、黑屏）。
  - `test_local_player`（列表发布、列表选择、媒体键、播完接下一个、最后一个结束、过期选择）、`test_local_media` 的同文件夹列表用例通过。`test_server_onboarding_webengine` 在 24 次运行里有 2 次在切换服务器时因页面导航与 CDP 调用竞争而失败，单独重跑 20 次全部通过，改动前的构建 5 次通过；判断为间歇性问题，和本改动无关的依据是失败点不经过本地播放代码。
- 安装器：`ISCC` 编译通过，预处理结果含 24 个扩展名的 `OpenWithProgids`。没有在本机实际安装安装包，「打开方式」菜单的注册没有在资源管理器里实测。
- 没有用真实服务器验证「播放服务器视频时打开本地文件」的停止上报，只按代码路径实现。
- 服务器选集：对照日志确认 2.9.4 同样会出现只有一集的队列（从剧集页「播放」或单集详情页开始），不是本分支引入的。`test_emby_season_list`（只有一集时读整季、列表与当前集、选集和上一个／下一个开始新队列、完整队列时交回 Emby、换季重新读取、电影不受影响）通过；还没有在真实服务器上播放验证。

## 还没做

- 把文件直接拖进已打开的窗口（目前只支持拖到程序图标或快捷方式上）。
- 本地文件的续播位置和最近播放记录。
- Mac 的以上各项。
