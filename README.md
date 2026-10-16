# Tigerest Theater / EMBY 大河版

<p align="center"><img src="screenshots/poster.webp" alt="大河影院 · EMBY 大河版宣传海报：电脑、平板、折叠屏与手机上的沉浸式首页"></p>

把 Emby 媒体库、MPV 播放器、弹幕和作品讨论放在一起。支持 Windows、Apple Silicon Mac、iPad、Android 与 Apple TV，提供 MPV 播放、弹幕和对应平台的画质选项。

[下载正式版](https://github.com/Tigerest/Tigerest-Theater/releases/latest) · [使用教程](https://github.com/Tigerest/Tigerest-Theater/wiki) · [更新记录](CHANGELOG.md) · [反馈问题](https://github.com/Tigerest/Tigerest-Theater/issues) · [作者 B站](https://space.bilibili.com/12562485)

**当前版本：Windows、Android 2.8.1；Mac、iPad 与 Apple TV 2.8.0。** Wiki 源文档同步保存在 [docs/wiki](docs/wiki/Home.md)。

**已知问题：** 部分 Windows 高刷新率环境下，窗口播放可能持续卡顿、增加输出丢帧，而全屏正常。2.8.1 仍未修复；遇到此现象请先使用全屏播放。详见[故障排查](https://github.com/Tigerest/Tigerest-Theater/wiki/Troubleshooting)。

客户端不包含影视资源。你需要已有的 Emby 服务器地址和账号；媒体库、播放与下载权限由所连接的服务器提供。本项目是非官方 Emby 客户端，与 Emby LLC 无隶属关系。

## 项目特色

<p align="center"><img src="screenshots/home.webp" alt="桌面沉浸式首页：左侧媒体库入口，右侧作品大图与继续观看轮播"></p>

**沉浸式首页：** 大海报、作品轮播和海报飞入详情的转场，红点与「观看进度：8/12」标出还没看完的作品；Windows 与 Mac 界面动画跟随显示器刷新率运行。

<table>
  <tr>
    <td width="50%">
      <b>五个平台都能用，画质开箱即用</b><br>
      Windows、Apple Silicon Mac、iPad、Android 与 Apple TV 都能连接自己的 Emby，各端内置 MPV 播放核心，无需另装播放器。桌面内置 shader 滤镜和画质调整，一键切换画质预设：默认档用 SSimDownscaler 改善缩小、KrigBilateral 重建色度、RAVU Zoom 放大并抗锯齿，再配合去色带与 EWA Lanczos 缩放；iPad 与 Apple TV 也能选用这套桌面预设。
    </td>
    <td width="50%"><img src="screenshots/quality-settings.webp" alt="MPV 画质与插件设置：大河内置模式、GPU-Next 渲染与画质预设"></td>
  </tr>
  <tr>
    <td width="50%"><img src="screenshots/watch-together.webp" alt="一起看房间：房间码、当前影片、开始放映与成员列表"></td>
    <td width="50%">
      <b>一起看（目前仅对大河 EMBY 用户开放）</b><br>
      房间里每个人都要用自己的大河 EMBY 账号登录，并有权限播放这部影片；连接自建 Emby 服务器时不显示入口。<br><br>
      创建房间后把 6 位房间码发给朋友，每个房间最多 4 人（服务器管理员账号创建的房间最多 20 人）。点「开始放映」后成员一起进入播放器、同时开始；所有人都能播放、暂停、拖动和换片，各端自动对齐进度。Windows、Android、Mac 与 iPad 2.8.0 起可用，Apple TV 暂不支持。
    </td>
  </tr>
  <tr>
    <td width="50%">
      <b>跨服务器公共评论</b><br>
      不同 Emby 服务器的观众可以讨论同一部作品，按 TMDB 与播出季集关联到「作品评论」「本集评论」，收到的回复集中在消息中心。自建服务器的登录凭据不会交给评论服务；大河用户还能在详情页直接上报播放或字幕问题。
    </td>
    <td width="50%"><img src="screenshots/comments.webp" alt="详情页评论区：评论账号、作品评论、上报问题与评论列表"></td>
  </tr>
  <tr>
    <td colspan="2">
      <b>弹幕自动匹配，纠正一次大家受益</b><br>
      播放时按作品、季度、集标题与集数自动找弹幕，五个平台都能显示，也可以和字幕同屏，并支持搜索、切换来源和调整时间偏移。匹配错了，大河用户手动纠正一次，所有用户都能读取这份共享对应关系。<br><br>
      <img src="screenshots/danmaku.webp" width="49%" alt="桌面播放时的满屏弹幕">
      <img src="screenshots/danmaku-subtitles.webp" width="49%" alt="桌面播放：弹幕与字幕同屏">
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <b>手机、折叠屏和平板同样顺手</b><br>
      Android 适配手机、折叠屏和平板的横竖屏与可变窗口；Android 与 iPad 支持横滑跳转、亮度／音量手势、长按倍速和锁定；Apple TV 用遥控器浏览海报墙和选集。<br><br>
      <img src="screenshots/android-home.webp" width="32%" alt="Android 竖屏首页：媒体库入口、作品大图与继续观看">
      <img src="screenshots/android-watch-together.webp" width="32%" alt="Android 一起看房间">
      <img src="screenshots/android-messages.webp" width="32%" alt="Android 消息中心：收到的回复与原发言">
      <br><br>
      <img src="screenshots/android-tablet-detail.webp" width="32%" alt="Android 折叠屏剧集详情页：播放、一起看入口与选集">
      <img src="screenshots/android-tablet-comments.webp" width="32%" alt="Android 折叠屏单集详情与本集评论">
      <img src="screenshots/android-tablet-danmaku.webp" width="32%" alt="Android 折叠屏播放：弹幕与字幕同屏">
    </td>
  </tr>
</table>

- **桌面离线与窗口操作：** 服务器允许时可下载作品离线播放；Windows 支持边缘吸附与一键全屏／窗口切换。
- **安心更新与完整中文教程：** Windows、Mac 与 Android 应用内更新核验 SHA-256，支持暂停与断点续传；安装、一起看、弹幕、字幕、补帧和故障排查都有独立的[中文 Wiki](https://github.com/Tigerest/Tigerest-Theater/wiki)。

<table>
  <tr>
    <td width="50%"><img src="screenshots/rife-settings.webp" alt="视频设置中的 AI 补帧开关、RIFE 模型与目标帧率"></td>
    <td width="50%">
      <b>可选 RIFE AI 补帧</b><br>
      Windows NVIDIA 最高支持 4K / 60 fps 输入，可选模型并自定目标帧率；Apple Silicon Mac 与 iPad 使用 Core ML / Metal，为 1080p / 30 fps 级别的 SDR 片源输出两倍帧率。需要大河内置播放配置，默认关闭。
    </td>
  </tr>
</table>

## 2.8.1 更新（Windows、Android）

- **首页重复作品：** 服务器上同一部作品有两个条目时，首页按 Emby 的作品身份合并为一张卡，保留最近一次播放的继续观看进度；同名的不同作品不合并。Mac、iPad 与 Apple TV 在 2.8.0 已修复，本次不更新。见 [2.8.1 发布说明](docs/releases/2026-10-17-v2.8.1.md)。

## 2.8.0 更新重点

- **一起看（Windows、Android、Mac、iPad）：** 目前仅对大河 EMBY 用户开放。登录大河服务器后，可以和朋友组一个房间同时观看同一部影片，房间里每个人都要用自己的大河 EMBY 账号登录。把 6 位房间码发给朋友即可加入，每个房间最多 4 人；所有成员都可以播放、暂停、拖动和换片。
- **一起开始：** 点「开始放映」后，房间页上的成员一起进入播放器，全部加载完成后同时开始；播放中各客户端自动对齐进度，中途加入的成员会追上。
- **入口：** 顶栏「消息」左边，以及电影、剧集详情页「播放」旁边（取代原来的「预告片」按钮）。选片页列出当前页面、本剧其他集、继续观看和最近添加。
- **评论账号自助修改：** 独立评论账号可以修改显示昵称和密码，注册和改密码时再输入一次密码确认。
- **首页媒体夹：** 「首页 → 首页媒体夹」可以隐藏媒体夹、调整顺序，按服务器和账号保存在本机。
- **播放修复：** 服务器给出的播放地址不带令牌时不再报 401；302 跳转到其他主机时不再把令牌带过去。
- **iPad 持续补帧：** 优化 RIFE 的 GPU 颜色转换与异步调度，保留原模型和画质预设；开启 RIFE 时避免房间同步反复微调倍速而打断补帧。
- **Mac 与首页：** 保留 Mac 高刷新率界面优化；修复苹果三端首页中同一作品重复出现，合并时保留继续观看信息。
- **Apple TV：** 更新版本与作品去重，提供海报墙、选集、字幕、弹幕、详情页评论和画质选项。电视端暂不包含「一起看」和 RIFE。

五个平台的安装包均已在同一发行页提供。「一起看」、评论账号自助修改和首页媒体夹设置适用于 Windows、Android、Mac 与 iPad；Apple TV 的线上房间服务尚未支持，暂不开放「一起看」。Mac／iPad 房间功能已通过隔离数据测试，真实跨设备多人播放尚未验证；补帧流畅度仍取决于片源与设备负载。完整范围与验证见 [2.8.0 发布说明](docs/releases/2026-10-16-v2.8.0.md)。

iPad 与 Apple TV 的 IPA 均未签名，需使用自己的 Apple 身份签名安装；两种设备包不能互换，也不提供 App Store／TestFlight 分发。见 [iPad 安装说明](docs/apple/INSTALL.md)与 [Apple TV 安装与构建](apple/TV/README.md)。

## 下载与安装

| 平台 | 安装包 | 系统要求 |
| --- | --- | --- |
| Windows 安装版 | [2.8.1 EXE](https://github.com/Tigerest/Tigerest-Theater/releases/download/v2.8.1/TigerestTheater-2.8.1-x64.exe) | Windows 10 1903+ / Windows 11，x64 |
| Windows 便携版 | [2.8.1 ZIP](https://github.com/Tigerest/Tigerest-Theater/releases/download/v2.8.1/TigerestTheater-2.8.1-x64.zip) | 同上；完整解压后运行 |
| Android | [2.8.1 APK](https://github.com/Tigerest/Tigerest-Theater/releases/download/v2.8.1/TigerestTheater-2.8.1-android.apk) | Android 15+，arm64-v8a / x86_64 |
| Apple Silicon Mac | [2.8.0 DMG](https://github.com/Tigerest/Tigerest-Theater/releases/download/v2.8.0/TigerestTheater-2.8.0-arm64.dmg) | macOS 26+，M 系列芯片 |
| iPad | [2.8.0 IPA](https://github.com/Tigerest/Tigerest-Theater/releases/download/v2.8.0/TigerestTheater-2.8.0-ipad.ipa) | iPadOS 26+，须自行签名安装 |
| Apple TV | [2.8.0 IPA](https://github.com/Tigerest/Tigerest-Theater/releases/download/v2.8.0/TigerestTheater-2.8.0-tvos.ipa) | tvOS 26+，须为 Apple TV 签名安装 |

包内已包含 MPV 和基础运行库，无需另装播放器。Windows RIFE 大型组件是可选扩展；已有 NVIDIA 1.0.0 扩展可以继续使用。正式 Mac 下载仅提供 Apple Silicon 版本。

Windows／Android 使用 [2.8.1 SHA-256 校验清单](https://github.com/Tigerest/Tigerest-Theater/releases/download/v2.8.1/TigerestTheater-2.8.1-SHA256SUMS.txt)；Mac／iPad／Apple TV 使用 [2.8.0 Apple 校验清单](https://github.com/Tigerest/Tigerest-Theater/releases/download/v2.8.0/TigerestTheater-2.8.0-APPLE-SHA256SUMS.txt)。来源与验证记录见各自发行页的 `RELEASE-MANIFEST.json` 和 `APPLE-RELEASE-MANIFEST.json` 附件。

### 第一次使用

1. 下载对应平台安装包。Windows 安装版运行向导；便携版完整解压；Mac 将应用拖入「应用程序」；Android 安装 APK；iPad／Apple TV 按上述说明签名并安装对应 IPA。
2. 打开客户端，选择「大河李斯特专属 EMBY」或「自建 EMBY」。
3. 自建服务器填写完整地址，例如 `http://192.168.1.100:8096` 或 `https://example.com/emby`，然后使用该服务器账号登录。
4. 进入作品详情并播放。桌面与移动端可在 Emby 设置中的「Tigerest Theater 设置」调整播放选项；Apple TV 使用原生页面和播放器菜单，画质从页面顶部「画质」进入。
5. 想参与公共讨论时，大河用户可直接进入评论区；自建用户点击「评论账号」注册或登录；Apple TV 请使用已有的公共评论账号登录。

专属服务器的权限与开通说明请查看[作者 B站主页](https://space.bilibili.com/12562485)中的充电说明；下载客户端不会自动获得服务器权限。

Windows 安装包目前未做 Authenticode 签名。Mac 使用 ad-hoc 签名，尚未经过 Apple 公证；确认文件来自本项目后，可按系统提示在「系统设置 → 隐私与安全性」中允许打开。详细步骤见 [安装与更新](https://github.com/Tigerest/Tigerest-Theater/wiki/Installation)。

### 从旧版更新

Windows、Mac 与 Android 客户端启动时后台检查正式版本，以右上角更新图标红点提示；也可在「客户端」设置中点击「检查客户端更新」。下载会核验文件大小与 SHA-256，支持暂停、继续和中断后的续传；Android 下载完成后交给系统安装器确认安装。

手动更新前完全退出客户端，包括 Windows 托盘。安装版覆盖安装；便携版备份并保留 `data`，使用完整新版文件；Mac 替换应用；Android 使用同签名正式 APK 覆盖安装。iPad 与 Apple TV 重新签名后覆盖安装，保留原应用标识和签名身份，不要先卸载。

iPad 应用内仅检查和提示更新，不自动替换安装；Apple TV 暂无内置更新检查，请从发行页获取新版。

旧版 Windows 的内置下载若反复失败，可从发行页手动安装一次。具体操作、跳过版本和校验方式见 [安装与更新](https://github.com/Tigerest/Tigerest-Theater/wiki/Installation)。

## 能做什么

### 浏览与播放

沉浸式首页展示当前账号可访问的媒体库和作品。首页默认按观看记录排列：看过的作品按最近一次观看在前，看过后又有新一集入库的剧集随之提前，从未播放的作品按最近入库在后；也可改为最近入库、发行时间或评分。内置 MPV 支持音轨、字幕、播放队列、选集和观看进度回传。

首页海报用红点标记尚有未观看内容的作品；剧集显示「观看进度：8/12」，表示已看 8 集、当前服务器共有 12 集。观看进度在首页显示后加载，播放返回时刷新。

桌面默认使用 GPU-Next，并提供 Render API 兼容模式。Windows 播放画面嵌入主窗口，Mac 使用独立播放窗口。设置按客户端、首页、音频、视频、字幕、MPV 画质与插件、弹幕样式和高级分类，支持搜索、即时保存与分类恢复默认值。

Android 提供双击暂停、横滑跳转、左右侧亮度／音量调节、长按临时倍速、防误触锁及选集。系统关闭自动旋转时保留当前方向。详见 [播放与设置](https://github.com/Tigerest/Tigerest-Theater/wiki/Playback)。

iPad 支持横滑跳转、左右侧亮度／音量调节、长按临时倍速、锁定和季集选择，播放时隐藏系统状态栏。Apple TV 使用遥控器操作首页与海报墙，支持选季选集、上一集／下一集、字幕选择和详情页内评论；电视端暂不提供音轨选择、离线下载、直播或服务端转码，完整范围见 [电视端说明](apple/TV/README.md)。

### 公共评论、头像与消息

电影和剧集按可靠的 TMDB 标识关联公共讨论；单集还需要明确的播出季集编号。详情页区分「作品评论」「本集评论」，每页 10 条主评论，可回复和删除自己的内容，正文最多 2000 字。

自建用户必须登录独立评论账号后才能读取或发送评论。这个账号与 Emby 账号分开；头像来自当前 Emby 的本人头像，发言时检查变化并按需同步。大河用户免注册，头像由服务端同步。

顶栏「消息」提供收到的消息与我的发言；大河用户还可查看我的报错及修复通知。详情页不再切换公共／本服评论；大河自动使用统一评论入口，保留旧回复、管理工具和私人问题上报，自建服务器使用公共评论账号。

缺少可靠作品编号或使用不支持的集序时，客户端会说明原因，避免把不同集数混到一起。参见 [评论账号与头像](https://github.com/Tigerest/Tigerest-Theater/wiki/Community) 和 [消息与私人报错](https://github.com/Tigerest/Tigerest-Theater/wiki/Messages-and-Reports)。

Apple TV 使用原生详情页评论区，支持作品／单集切换、分页、回复和管理自己的评论；公共账号需使用已有账号登录，暂不提供公共账号注册、管理审核或与桌面相同的顶栏消息页。

### 弹幕与共享校准

新配置默认启用弹幕，已有明确关闭的设置会保留。播放时先查共享匹配，再按作品、季度、集标题与集数自动识别；仍有歧义时可手动选择。

桌面与 Android 均可搜索、管理来源、调整时间偏移和样式。大河用户手动选择正确的作品与集数后，可使用当前 Emby 登录保存共享对应关系；保存失败仍能加载本次选择，并显示提示。自建用户可读取共享结果。

桌面内置弹幕下载和共享查询遇到超时或临时网络故障会等待 1 秒后自动重试一次；空结果和限流不反复请求，切集或手动换源会取消旧请求。

视频来自你的 Emby；弹幕搜索和匹配信息会发送到所用弹幕服务。手动配置的第三方来源保留原设置。操作示例见 [弹幕匹配与纠正](https://github.com/Tigerest/Tigerest-Theater/wiki/Danmaku)。

iPad 与 Apple TV 复用作品搜索和匹配规则，提供原生弹幕渲染，以及搜索、来源和时间偏移调整。

### 画质与 AI 补帧

桌面内置默认 Anime AA、真人影视、激进测试 Anime4K 三档画质；可以从菜单切换，也可以使用 `Alt+1`～`Alt+3`。日常先使用默认档，再按片源和设备调整。

RIFE 默认关闭，需要大河内置播放配置：

| 平台 | RIFE 方式 | 输入范围 |
| --- | --- | --- |
| Windows NVIDIA | 下载或离线导入 NVIDIA 1.0.0 扩展；三个 4.25 系列模型与可调目标帧率 | 最高逐行 SDR 4K / 60 fps；实际实时性能取决于设备和设置 |
| Apple Silicon Mac | 模型与插件随包提供，使用 Core ML / Metal | 最高逐行 SDR 1080p / 30 fps、恒定帧率，输出两倍帧率 |
| iPad | 随包 Core ML / Metal 原生滤镜，默认关闭 | 1920×1080、BT.709 SDR、23–30 fps，固定两倍；其他规格原帧通过 |
| Android | 暂不提供 RIFE | 使用基础播放 |
| Apple TV | 暂不提供 RIFE | 可选原生、轻量增强及桌面画质预设 |

Apple TV 的轻量增强会在高帧率视频或持续渲染掉帧时暂时降低当前视频的处理负载，并保留所选设置。完整桌面滤镜在较早电视设备上仍可能掉帧。

首次 Windows 引擎准备可能需要数分钟。高目标帧率、4K 和重型模型会增加负载；屏幕刷新率不代表补帧推理能力。详细安装、目标帧率计算和排查见 [RIFE 补帧](https://github.com/Tigerest/Tigerest-Theater/wiki/RIFE)。

### 桌面离线媒体

服务器允许下载时，可创建下载任务，暂停、恢复或删除，并从下载与离线媒体管理中播放已完成文件。Android 当前不提供离线下载、后台持续播放或画中画。参见 [下载与离线播放](https://github.com/Tigerest/Tigerest-Theater/wiki/Downloads)。

## 中文 Wiki

| 我想要…… | 教程 |
| --- | --- |
| 从头开始使用 | [教程首页](https://github.com/Tigerest/Tigerest-Theater/wiki/Home) |
| 安装、更新、核验下载 | [安装与更新](https://github.com/Tigerest/Tigerest-Theater/wiki/Installation) |
| 连接自己的服务器或更换账号 | [服务器与登录](https://github.com/Tigerest/Tigerest-Theater/wiki/Server) |
| 和朋友一起看同一部影片 | [一起看](https://github.com/Tigerest/Tigerest-Theater/wiki/Watch-Together) |
| 注册评论账号、改密码、更新头像 | [公共评论与头像](https://github.com/Tigerest/Tigerest-Theater/wiki/Community) |
| 找回复、查看修复通知、上报问题 | [消息与私人报错](https://github.com/Tigerest/Tigerest-Theater/wiki/Messages-and-Reports) |
| 弹幕匹配错集、调时间或来源 | [弹幕教程](https://github.com/Tigerest/Tigerest-Theater/wiki/Danmaku) |
| 调播放、声音、画质或 Android 手势 | [播放与设置](https://github.com/Tigerest/Tigerest-Theater/wiki/Playback) |
| 选择字幕、修正延迟、保留 ASS 特效 | [字幕教程](https://github.com/Tigerest/Tigerest-Theater/wiki/Subtitles) |
| 安装与调试 AI 补帧 | [RIFE 教程](https://github.com/Tigerest/Tigerest-Theater/wiki/RIFE) |
| 下载作品并离线播放 | [下载管理](https://github.com/Tigerest/Tigerest-Theater/wiki/Downloads) |
| 在 Apple TV 上使用 | [Apple TV](https://github.com/Tigerest/Tigerest-Theater/wiki/Apple-TV) |
| 解决异常或准备反馈 | [故障排查](https://github.com/Tigerest/Tigerest-Theater/wiki/Troubleshooting) · [常见问题](https://github.com/Tigerest/Tigerest-Theater/wiki/FAQ) |
| 了解各客户端的实现与架构 | [技术原理](https://github.com/Tigerest/Tigerest-Theater/wiki/Architecture) |

## 反馈与支持

播放器问题请提交 [GitHub Issue](https://github.com/Tigerest/Tigerest-Theater/issues)，写明客户端版本、系统、复现步骤与错误提示。日志和截图请先删除密码、访问令牌及私人服务器信息。大河某部作品的播放或字幕问题，可直接在详情页「上报问题」中提交。

项目动态与支持入口：[大河李斯特视频工作室 / 大老师的 B站主页](https://space.bilibili.com/12562485)。

## Star 趋势

觉得好用的话，欢迎点个 Star。

<a href="https://www.star-history.com/#Tigerest/Tigerest-Theater&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Tigerest/Tigerest-Theater&type=Date&theme=dark">
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Tigerest/Tigerest-Theater&type=Date">
    <img alt="Tigerest Theater 的 GitHub Star 数随时间变化的折线图" src="https://api.star-history.com/svg?repos=Tigerest/Tigerest-Theater&type=Date">
  </picture>
</a>

## 贡献者

- [大河李斯特（Tigerest）](https://github.com/Tigerest)：项目维护、开发与发布。
- [Claude](https://github.com/claude)：AI 辅助开发。
- [Codex](https://github.com/codex)：AI 辅助开发、调试与验证。

## 开发与许可

客户端源码在本仓库维护，评论和弹幕服务端单独维护。公开客户端源码不包含服务器资源、账号或访问权限。

- [Windows 构建](dev/windows/README.md)
- [macOS 构建](dev/macos/README.md)
- [Android 构建](android/README.md)
- [iPad 安装与构建](docs/apple/INSTALL.md)
- [Apple TV 安装与构建](apple/TV/README.md)
- [Windows 测试环境要求](dev/windows/TESTING.md)
- [版本变化](CHANGELOG.md)与本次发布说明（[2.8.1](docs/releases/2026-10-17-v2.8.1.md)、[2.8.0](docs/releases/2026-10-16-v2.8.0.md)）

Windows 每次运行原生测试前，都必须在同一个 PowerShell 调用中加载测试环境脚本并完成运行库预检。测试、包启动检查、生产 API 联调和真实媒体播放的覆盖范围分别记录，不能互相替代。

项目沿用 Jellyfin Desktop 代码基础，并使用 MPV、Qt、[uosc](https://github.com/tomasklaen/uosc)、[uosc_danmaku](https://github.com/Tony15246/uosc_danmaku)、Anime4K 与 RIFE 等组件，感谢相关项目及贡献者。

主项目许可证见 [LICENSE](LICENSE)（GNU GPL v2）；第三方组件按各自许可证分发，具体来源、修改及许可文件随源码和发行包提供。
