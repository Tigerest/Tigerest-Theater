# 大河影院 Android 客户端

独立 Kotlin 工程，最低 Android 15（API 35），目标 API 36，内置 arm64-v8a / x86_64 的 libmpv，无需另装播放器。现有 `native/` 网页插件、消息中心、评论与深色金色样式在构建时同步到 APK；安卓通过限定来源的 WebMessage 桥接替换 Qt WebChannel。

当前正式版为 2.9.5（versionCode 2090500）。2.9.5 更新共用网页插件和页面转场：从剧集页点「播放」时 Emby 只把这一集排进队列，选集列表现在列出这一季，可以选集和上一集／下一集；点下海报或媒体库后，下一个页面在 0.7 秒内就能操作，海报按下就起飞，页面背景光晕改用预先画好的小图（和 Mac 相同），转场中不再闪烁。大河专属服务器的公网连接改用 HTTPS（局域网不变），保存的旧公网地址在启动时换成新地址，升级后需要重新登录一次 Emby。versionCode 由版本号算出，末两位是四段版本号的第四段（2.9.5.1 为 2090501）；检查更新能识别这类修复版，更新窗口显示「versionCode · 提交编号」形式的构建号。JNI 原生库与 2.9.0 相同。2.9.4 下载更新时先走 GitHub 加速镜像，下载好后用 PackageInstaller 会话直接交给系统安装（首次需允许安装应用，系统不允许更新后自动重新打开）；检查更新先请求社区服务器的签名版本列表，验签失败或连不上时改问 GitHub。共用网页插件更新了桌面的海报转场（0.7 秒截止落地）；触屏设备仍先抬起海报、等新页面稳定后再飞，Android 上的转场方式与 2.9.3 相同。JNI 原生库与 2.9.0 相同。2.9.3 在 HDR 屏幕上把 HDR10／HLG 视频用 MediaCodec 直接输出到 SurfaceView（`vo=mediacodec_embed`），由系统合成 HDR 图层，文本字幕由原生叠加层按用户字幕设置绘制，图形字幕和没有 HDR10 基础层的杜比视界仍走 mpv 色调映射；开始播放时显示与 Mac、iPad 相同的 HDR／SDR 提示；旋转时不再重启解码。更新提醒改为每次启动弹窗一次并提供网盘下载。JNI 原生库与 2.9.0 相同。2.9.1 只更新共用网页插件：Jellyfin 服务器提供的自定义 CSS 默认禁用、默认主题下的海报圆角与标签栏滚动条、首页横滑不再误切标签；原生部分与 2.9.0 相同。2.9.0 支持连接 Jellyfin 服务器（见 [Jellyfin 连接与兼容范围](../docs/jellyfin-compatibility.md)），连接过的自建服务器会记在切换服务器页面；视频在播放器画面就绪后才开始，Jellyfin 页面切换时原生桥保持连接。原生库与 2.8.0 相同。2.9.0 同时带上原定 2.8.1 的首页去重：服务器上同一作品有两个条目时，共用网页首页按 Emby 的作品身份（PresentationUniqueKey）合并；原生部分与 2.8.0 相同。2.8.0 带上与桌面共用的「一起看」：在大河服务器上组房间同步观看，房间里的影片暂停加载、由房间统一开始；应用切到后台时只暂停本机播放，不让整个房间暂停。同时带上独立评论账号自助修改昵称和密码、首页媒体夹的隐藏与排序（设置项 `home.libraryLayout`），以及给不带令牌的本服务器播放地址补上令牌。原生库与 2.7.0 相同。2.6.0 新增跨服务器公共评论、独立评论账号、按服务能力显示 8–128／12–128 字符密码要求，以及发言时的本人 Emby 头像同步。大河登录可直接保存手动共享弹幕绑定，无需管理员令牌文件。正式包沿用已有签名。

保留首页排序、播放防误触锁、选集、直接上下集按钮与系统旋转锁。更新包下载支持暂停、重启后续传与自动重试。报错说明为 3–2000 字，可按分秒填写发生时间，并附带最近约 10 分钟的脱敏日志。普通用户教程见 [Wiki](https://github.com/Tigerest/Tigerest-Theater/wiki/Home)。

## 使用

下载 [V2.9.5 APK](https://github.com/Tigerest/Tigerest-Theater/releases/download/v2.9.5/TigerestTheater-2.9.5-android.apk)，完整附件见[发行页](https://github.com/Tigerest/Tigerest-Theater/releases/latest)。打开“大河影院”，选择服务器或输入自己的 Emby 地址，再使用该服务器账号登录。同签名正式包可覆盖升级并保留登录和设置；调试包与正式包的数据分开。Emby 登录信息保留在应用私有 WebView 中，公共评论会话使用 Android Keystore 加密保存。

视频播放自动进入沉浸界面，返回网页时恢复系统栏，安卓不显示桌面全屏／窗口按钮。开始播放及缓冲时显示加载转圈。轻触空白处显示／隐藏控制栏，播放时约 3.5 秒自动收起；拖动进度或打开菜单时保持显示。常用暂停、前后跳转、选集、上一集、下一集、弹幕和倍速直接显示；音轨、内嵌及 Emby 外置字幕、字幕偏移、画质和客户端设置在“更多”中。顶部「防误触」隐藏控制栏并屏蔽手势和返回，长按「长按解锁」恢复操作。音频保留网页播放器界面。应用进入后台时暂停；当前版本未实现后台持续播放、画中画、离线下载或桌面 RIFE 补帧。

横屏时关闭系统「自动旋转」会保持当前方向，换集、返回作品或首页仍有效；重新开启自动旋转后恢复系统控制。无需在播放器里再开启方向锁，也不修改系统旋转设置。

第一次播放视频展示手势教程，之后可从“更多 → 手势教程”再次查看。双击画面播放／暂停；横向滑动预览快进／快退，松手跳转，取消手势不提交；左侧上下滑动调整当前播放窗口亮度，离开播放器恢复；右侧上下滑动调整系统媒体音量。**长按空白画面临时至少 2 倍速**，原速度高于 2 倍时保持原速度；松手、取消、切到后台或换片后恢复原倍速，中央不显示遮挡画面的倍速提示。请从画面内部开始，按钮、进度条及屏幕边缘保留原操作。亮度不修改系统设置，不需要额外授权。教程期间收到新的暂停、耳机断开或音频焦点丢失时，关闭教程不会强行恢复播放。

弹幕支持按作品／季／集自动匹配，手动作品搜索、集数选择、视频网站来源、XML / JSON / ASS 文件导入、源屏蔽、时间偏移和样式。源策略按作品季及稳定提供方保存，弹幕内容按集缓存。自动匹配遇到不明确的续季或特别篇会提示手动选择。「弹幕样式 → 弹幕服务地址」可填兼容 Dandanplay API 的服务地址；默认使用现有大河弹幕服务。

弹幕使用屏幕帧时钟补齐 mpv 视频时间戳之间的运动，独立于视频帧率；暂停、缓冲、跳转和倍速仍以播放器状态同步。诊断分别记录重绘次数和滚动位置变化次数，不能用重绘次数代替实际运动帧率。

从 2.4.2 起，每次启动后台检查正式发布，右上角更新图标以红点提示新版本。**2.9.3 起每次打开软件弹窗一次**：检查在用户开始操作前完成才弹；来不及时保留结果，下次启动立刻弹出并在后台刷新。窗口提供「直接下载／备用下载／忽略本次更新／稍后」，「备用下载」展开夸克网盘与百度网盘按钮（直接下载失败后自动展开）；「直接下载」依次尝试 gh-proxy.com、ghproxy.net 和 GitHub 原址（`DownloadSources`），镜像下载的 APK 未通过 SHA-256 或签名核验时只从 GitHub 原址重下一次；百度网盘按钮先在后台匿名读取内置（或发行说明指定的）分享列表，找到以版本号命名的子文件夹后以 ACTION_VIEW 打开百度手机网页的该文件夹（`/wap/link?surl=…#/home/%2F/<路径>`；装有百度网盘应用时可能由应用接管），找不到时打开整个分享。夸克手机网页没有子文件夹地址，夸克按钮直接打开分享首页。「客户端」设置分类提供手动检查和自动检查开关。点击更新后下载并核验，再交给系统安装器；首次需在系统页面允许“大河影院”安装应用，系统安装确认仍需手动完成。拒绝授权或取消安装后可重试。更新保留现有应用数据，下载期间切换网页或窗口不会丢失更新状态。

2.5.1 将下载缓存按正式元数据的 SHA-256 命名。暂停保留已下载字节，继续下载或应用重启后检查同一版本可从断点继续；忽略本次更新会清理该版本缓存。下载中断按 2／5／10／20／30 秒自动重试，重新下载相同前缀或在旧进度以内反复波动不会无限重置预算。HTTP 206 必须精确匹配剩余范围，200 覆盖旧前缀，416 或不匹配的范围从零重试。完整缓存直接验证 SHA-256、APK 包名、版本、签名、系统与处理器兼容性，安装前再次验证；缓存校验失败会清理损坏包。Android 可回收应用缓存，因此缓存被系统清理后会从零下载。

布局依据当前窗口及密度，支持横竖屏、内外屏切换、自由窗口和分屏尺寸。遇到系统上报的分隔折痕时使用可用的一侧。背景和视频覆盖到挖孔区域，仅交互控件避开挖孔及系统栏；2.4.3 减少网页多层叠加的安全区留白，并调整窄屏顶栏。键盘缩小网页区域，自由窗口标题栏单独处理。屏幕变化不会主动重载网页或媒体；视频表面改变尺寸时重新配置 EGL 输出，保留播放时间和暂停状态。

## 设置与评论

客户端设置分类直接并入 Emby 左侧菜单，使用配套图标；窄屏通过原生抽屉访问，内容区只显示当前分类表单。仅显示安卓支持的选项，保留搜索、保存和分类恢复默认值。

详情页默认公共评论，区分「作品评论」「本集评论」，每页 10 条主评论，回复跟随主评论。大河用户自动建立评论身份，保留本服评论、私人报错和统一消息；自建用户必须注册／登录独立评论账号后查看和发送公共评论，自己的 Emby 凭据只用于自己的服务器。公共讨论依靠可靠 TMDB 和播出季集关联，缺少标识或集序不支持时显示原因。

注册／改密按服务能力显示新服务 8–128 或旧服务 12–128 个 Unicode 码点，禁止控制字符，允许中文、emoji 和普通空格。新头像能力已在后端开放：自建用户每次发言检查本人 Emby 头像，评论成功后按需上传；头像失败使用「重试头像同步」，不会重发正文。大河头像由服务端同步。账号切换会清理旧评论、预览和图片。详见 [公共评论与头像](https://github.com/Tigerest/Tigerest-Theater/wiki/Community)、[消息与私人报错](https://github.com/Tigerest/Tigerest-Theater/wiki/Messages-and-Reports)。

## Windows 构建

需要 Git、Python 3、PowerShell。首次准备依赖与构建：

```powershell
./android/build.ps1 -Bootstrap
```

脚本使用 `toolchain.lock.json` 中固定 URL 和 SHA-256 下载 JDK 21、Gradle 8.13、SDK 命令行工具及官方 mpv-android APK，依赖缓存默认在 `D:\CodexDeps\TigerestTheater\android`。可用 `-DependencyDirectory` 改变位置。SDK 安装使用 Android 的标准许可接受流程；首次下载需要网络。

Windows 上 Gradle/JUnit 对中文路径的类发现有问题，脚本创建 ASCII 目录联接，默认 `C:\A\tigerest-android`。如果它已指向别的仓库，指定另一个 `-AsciiWorkspace`；脚本不会替换现有目录。Android Studio 可在依赖准备完成后打开这个联接下的 `android` 工程。

```powershell
./android/build.ps1 -Tasks testDebugUnitTest,lintDebug,assembleDebug,assembleDebugAndroidTest,assembleRelease
./android/tools/sign_release.ps1
```

签名脚本首次生成本地发布密钥，保存到依赖缓存的 `signing` 目录并限制 ACL。请备份该目录中的密钥和配对密码文件；后续更新必须沿用此密钥。密钥、密码、JNI 二进制、构建输出和临时测试资料均不进入 Git。可用 `-SigningDirectory` 指定自己的密钥目录；上架时应使用项目的正式签名流程。

`verify_apk.py` 检查实际 APK 中所有 20 个原生库：与锁文件的 SHA-256 完全相同、ELF PT_LOAD 至少 16 KB 对齐、ZIP 不压缩且数据偏移按 16 KB 对齐。此检查不能替代 16 KB 设备的实际运行测试。

## 测试

调试版包名是 `top.tigerest.theater.debug`，与正式版 `top.tigerest.theater` 分开保存数据。设备测试使用本机 HTTP 夹具、`adb reverse` 与调试 WebView 的 CDP；不会向生产评论／消息接口写入。Node.js 24+ 可运行以下脚本；通过环境变量 `ADB`、`ANDROID_SERIAL` 指定设备。

调试启动参数 `url` 会保存到该调试版的服务器地址。HTTP 夹具关闭后，保存的 `127.0.0.1:PORT` 会无法连接；覆盖安装 APK 仍保留此地址。将调试版交给用户预览前，必须通过应用的服务器连接页恢复真实地址，并核对保存值及真实页面加载；安装成功不能代替这项检查。不要清除正式版数据，也不要在报告中输出登录凭据。

```powershell
adb install --no-incremental -r android/app/build/outputs/apk/debug/app-debug.apk
adb install -r -t android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb shell am force-stop top.tigerest.theater.debug
adb shell am instrument -w top.tigerest.theater.debug.test/androidx.test.runner.AndroidJUnitRunner
node --test android/tests/test_android_bridge.cjs tests/test_nativeshell_window_button.cjs
$env:TIGEREST_ANDROID_FIXTURE='1'
node tests/test_community_messages_ui.cjs android --webengine
node android/tests/test_comments.cjs
node android/tests/test_settings.cjs
node android/tests/test_shared_players.cjs
node android/tests/test_danmaku.cjs
node android/tests/test_windows.cjs
node android/tests/test_freeform.cjs
node android/tests/test_keyboard.cjs
node android/tests/test_navigation.cjs
node android/tests/test_player_layout.cjs
node android/tests/test_danmaku_motion.cjs
node android/tests/test_gestures.cjs
```

更新流程的实机夹具见 `tests/test_app_update.cjs`，其中 2.4.1 → 2.4.2 是测试专用版本组合，不代表当前正式版。先将同一份代码构建为调试版 2.4.1（versionCode 2040103）作为已安装旧版本，再保存同签名的调试版 2.4.2（2040200）到 `test-artifacts/update-candidate-2.4.2-debug.apk`。可通过 `TIGEREST_UPDATE_APK` 指定候选包。脚本验证启动检查、稍后与跳过、手动检查、损坏包拒绝、取消重试和导航后的安装交接，结束在系统授权／安装页，需继续完成系统确认并核对安装后版本。

仅调试版支持启动参数 `updateFixture=http://127.0.0.1:PORT`，将版本请求和下载传输映射到本地 `/releases` 与 `/download`；元数据仍需满足正式源、文件名、哈希与 APK 身份规则。发布版忽略此入口，更新地址不能由网页传入。夹具验证不能代替 GitHub 生产网络和真实安装确认测试。

`AppUpdateResumeTest` 与 `AppUpdateTransferTest` 在 JVM 临时目录中验证暂停与进程重建、取消后的旧任务隔离、完整缓存直接核验、损坏缓存拒绝、严格 Content-Range、短响应、取消写入和连续失败上限。`AndroidAppUpdateSourceTest` 使用本机 MockWebServer 验证生产下载适配器实际发出的 Range／identity 请求、416 清空重试和 503 保留缓存；它不替代 Android PackageManager 的真实签名解析或系统安装验收。

2.5.1 的本地构建、JVM／HTTP 夹具和 APK 对齐检查见[更新器本地验证记录](docs/update-resume-2.5.1-verification.md)。该记录不代表已完成真机安装、GitHub 生产传输或真实播放验收。

媒体测试需要 `android/test-artifacts/playback-fixture.mp4`。用 FFmpeg 生成 90 秒 H.264 720p、两个 AAC 音轨的测试文件：

```powershell
ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=24 -f lavfi -i sine=frequency=440:sample_rate=48000 -f lavfi -i sine=frequency=660:sample_rate=48000 -t 90 -map 0:v -map 1:a -map 2:a -c:v libx264 -preset ultrafast -crf 28 -c:a aac -metadata:s:a:0 language=eng -metadata:s:a:1 language=jpn -movflags +faststart android/test-artifacts/playback-fixture.mp4
```

`test_windows.cjs` 与 `test_player_layout.cjs` 专门针对此次连接的折叠机：内屏 2224×2488、外屏 1080×2520，设备状态 3/0。它们保存并恢复旋转等覆盖，结束后重置为物理设备状态；不同机型应先调整状态／分辨率断言。播放器布局测试覆盖两面板的横竖屏、触控边界、长按拖动、菜单与自动隐藏；应同时目视检查截图，几何断言无法识别视频纹理重复。字幕 UI 测试读取当前播放器区域定位，支持在内外屏执行。通用功能代码不依赖这些测试尺寸。

通用媒体夹具在独立调试配置中预置“已看过教程”；手势测试自行清除此标记，验证真正的首次教程、关闭后不重复、菜单重看及外部暂停优先级。测试不会修改正式版教程状态。2.4.3 的界面与手势覆盖见 [UI 修订报告](../docs/reports/2026-10-07-ui-polish.md)，最终调整见 [播放性能复查报告](../docs/reports/2026-10-07-playback-performance-followup.md)；早期功能验证见 [Android 正式版报告](../docs/reports/2026-10-06-android-stable.md)。

2.5.0 发布验证包括 JVM 测试、Lint、签名和原生库 16 KB 对齐，以及独立调试版真机控制栏、误触锁、选集和系统旋转锁验证。`tests/test_playback_controls.cjs` 使用当前运行的调试版，临时导航到仅调试包包含的验收页，结束恢复原网页与系统旋转设置并确认测试队列已清理；不保存测试服务器地址。折叠设备实测使用 Android 16；Android 15、x86_64 与 16 KB 页设备尚未实机验收。完整结果见[发布验证清单](https://github.com/Tigerest/Tigerest-Theater/releases/download/v2.5.0/TigerestTheater-2.5.0-RELEASE-MANIFEST.json)。

## 原生来源与许可

内置未修改的 [mpv-android 2026-09-17 官方发布](https://github.com/mpv-android/mpv-android/releases/tag/2026-09-17) 中的原生库和对应 MIT JNI 绑定。运行时报告 `mpv v0.41.0-1049-g0b7ed670f`。源代码与原生构建方法在[该版本 buildscripts](https://github.com/mpv-android/mpv-android/tree/2026-09-17/buildscripts)，mpv 对应[提交 0b7ed670f](https://github.com/mpv-player/mpv/tree/0b7ed670f)。本工程复现固定二进制的打包；上游部分原生依赖采用浮动提交，不能据此声称原生编译结果逐字节可复现。

mpv 默认构建为 GPLv2 或更新版，上游 FFmpeg 开启 GPL 和 version3，因此本原生组合适用 GPLv3 或更新版。MIT、GPL、LGPL、Apache 及依赖许可文本在 `app/src/main/assets/licenses/` 并随 APK 打包。JNI 来源哈希和二进制哈希分别在构建脚本与锁文件记录。

正式版同时提供 [TigerestTheater-2.9.5-android-Sources.zip](https://github.com/Tigerest/Tigerest-Theater/releases/download/v2.9.5/TigerestTheater-2.9.5-android-Sources.zip) 和[来源清单](https://github.com/Tigerest/Tigerest-Theater/releases/download/v2.9.5/TigerestTheater-2.9.5-android-SOURCE-MANIFEST.json)，包含客户端源码、上游应用／JNI／原生构建脚本及官方发布列出的固定依赖与子模块。源码包内 `unpack_native_sources.py` 可用 Python 3.12+ 解包；具体编译要求见包内 README。未重新编译原生库，不宣称原生二进制逐字节可复现。原生运行库未改变时，可用 `tools/package_sources.py --previous <已验证的源码附件> --apk <签名 APK> --output <新版-Sources.zip>` 更新客户端源码；它验证原生锁文件与每份旧源档案哈希，并只打包已提交的 Git 源码。原生依赖改变时必须重新收集对应源码。
