# Tigerest Theater 使用教程

这里是 EMBY 大河版的中文使用说明，对应 Windows 2.9.5.1，以及 Android、Mac、iPhone／iPad 与 Apple TV 2.9.5。客户端支持 Windows、Apple Silicon Mac、Android、iPad／iPhone 和 Apple TV；播放内容和访问权限来自你连接的 Emby 或 Jellyfin 服务器。

## 第一次使用

1. 按设备选择并安装[正式版本](https://github.com/Tigerest/Tigerest-Theater/releases/latest)：见[安装与更新](https://github.com/Tigerest/Tigerest-Theater/wiki/Installation)。
2. 选择大河专属入口或填写自己的 Emby／Jellyfin 地址：见[服务器与登录](https://github.com/Tigerest/Tigerest-Theater/wiki/Server)。
3. 登录服务器，打开一部作品并播放：见[播放与设置](https://github.com/Tigerest/Tigerest-Theater/wiki/Playback)。Apple TV 的操作方式不同，见 [Apple TV](https://github.com/Tigerest/Tigerest-Theater/wiki/Apple-TV)。
4. 根据需要选择字幕、检查弹幕。先用默认设置播放，再调整画质或启用补帧。
5. 自建 Emby 用户想看公共评论时，打开详情页的「评论账号」完成独立注册或登录。

## 按任务查找教程

| 任务 | 页面内容 |
| --- | --- |
| [安装与更新](https://github.com/Tigerest/Tigerest-Theater/wiki/Installation) | 系统要求、安装版与便携版、iPad／iPhone 与 Apple TV 签名安装、覆盖更新、SHA-256 |
| [服务器与登录](https://github.com/Tigerest/Tigerest-Theater/wiki/Server) | 地址格式、反向代理路径、切换服务器、媒体权限、两种账号 |
| [一起看](https://github.com/Tigerest/Tigerest-Theater/wiki/Watch-Together) | 创建和加入房间、一起开始、同步方式、换片、房主操作 |
| [公共评论与头像](https://github.com/Tigerest/Tigerest-Theater/wiki/Community) | 注册、修改昵称和密码、发言与回复、头像同步 |
| [消息与私人报错](https://github.com/Tigerest/Tigerest-Theater/wiki/Messages-and-Reports) | 回复、我的发言、报错、日志附件、修复通知与已读状态 |
| [弹幕匹配与纠正](https://github.com/Tigerest/Tigerest-Theater/wiki/Danmaku) | 自动匹配、手动选集、共享校准、来源屏蔽与偏移 |
| [播放与设置](https://github.com/Tigerest/Tigerest-Theater/wiki/Playback) | 设置入口、首页媒体夹、声音、画质、快捷键、Android 与 iPad／iPhone 手势 |
| [字幕](https://github.com/Tigerest/Tigerest-Theater/wiki/Subtitles) | 选轨、外置字幕、时间偏移、样式与 ASS 特效 |
| [RIFE 补帧](https://github.com/Tigerest/Tigerest-Theater/wiki/RIFE) | Windows 扩展、Mac 与 iPad 内置补帧、目标帧率、性能检查 |
| [下载与离线媒体](https://github.com/Tigerest/Tigerest-Theater/wiki/Downloads) | 下载任务、离线播放、数据保留与权限 |
| [Apple TV](https://github.com/Tigerest/Tigerest-Theater/wiki/Apple-TV) | 电视端登录、遥控器操作、字幕、弹幕、评论与画质 |
| [故障排查](https://github.com/Tigerest/Tigerest-Theater/wiki/Troubleshooting) | 按现象定位问题、日志目录、提交有效反馈 |
| [常见问题](https://github.com/Tigerest/Tigerest-Theater/wiki/FAQ) | 平台区别、账号范围、补帧与共享功能的常见疑问 |
| [技术原理](https://github.com/Tigerest/Tigerest-Theater/wiki/Architecture) | 各客户端的实现与架构、播放链路、一起看同步、评论和弹幕的数据流 |
| [引用来源与鸣谢](https://github.com/Tigerest/Tigerest-Theater/wiki/Credits) | 用到的开源项目、用途和许可证，源码与许可文件在哪里 |

## 2.9.5.1 更新了什么（只有 Windows）

- **高刷新率屏幕上的播放节奏：** 按音频时钟播放时（窗口补帧，或音画同步选了「音频」），播放内核把每一帧对准屏幕刷新提交，240 Hz 屏幕上 59.94 帧在 3 次、5 次刷新之间交替的情况大幅减少，弹幕移动更平稳。
- **全屏补帧保留显示器重采样：** 弹幕每次屏幕刷新都移动；被系统合成时自动改回音频时钟。补帧暂停 5 秒以上再继续时先重新准备画面，实测恢复后不再掉帧。见 [AI 补帧](https://github.com/Tigerest/Tigerest-Theater/wiki/RIFE#windows-的同步方式)。
- **字幕字体：** 默认改为微软雅黑粗体，中文整行同一字体；新增「字幕粗体」设置。见[字幕](https://github.com/Tigerest/Tigerest-Theater/wiki/Subtitles)。

## 2.9.5 更新了什么

- **加密连接：** 大河专属服务器的公网连接改用 HTTPS，局域网不变。升级后需要重新登录一次 Emby（Apple TV 不用）；2.9.4 及更早的版本在旧地址关闭后无法从公网连接，请尽快升级。
- **本地播放器（Windows 与 Mac）：** Windows 对视频文件右键「打开方式」选大河影院，Mac 在访达里选「打开方式 → 大河影院」，不连服务器就能播放；同一文件夹的视频按文件名排成播放列表，播完接下一集。本地播放不加载弹幕、不上报进度。见[播放本地视频](https://github.com/Tigerest/Tigerest-Theater/wiki/Playback#播放本地视频windows-与-mac)。
- **服务器播放选集：** 从剧集页点「播放」时 Emby 只排了这一集，播放列表现在列出这一季，可以选集和上一集／下一集。
- **Android 页面转场：** 点下海报或媒体库后，下一个页面在 0.7 秒内就能操作；海报按下就起飞，转场中不再闪烁。
- **离线媒体有声音和字幕（Windows 与 Mac）**；没连服务器时服务器选择页的「设置」也能打开完整设置。
- **统计信息：** 第 2 页默认画出各渲染步骤的耗时曲线（Windows 与 Mac）。
- **版本号与构建号：** 之后的小修复用四段版本号（如 2.9.5.1）；更新窗口显示构建号。

## 2.9.4 更新了什么

- **更新下载与安装：** 「直接下载」先走 GitHub 加速镜像，下完仍按 GitHub 的 SHA-256 核对；Windows 安装版点「安装更新」后自动关闭、安装并重新打开；Android 下载后直接交给系统安装。检查更新改为先问社区服务器（签名验证），连不上再问 GitHub。见[安装与更新](https://github.com/Tigerest/Tigerest-Theater/wiki/Installation#应用内更新)。
- **一份可以直接改的 mpv.conf（Windows 与 Mac）：** 在「设置 → 播放器设置 → MPV 画质与插件」下方的编辑器里修改，保存后立即生效；原来的配置模式、「高级」页和 `user-overrides.conf` 不再使用，升级时旧内容备份到「旧版自定义配置备份.txt」。见[自定义 mpv.conf](https://github.com/Tigerest/Tigerest-Theater/wiki/Playback#自定义-mpvconfwindows-与-mac)。
- **设置菜单：** 左侧菜单分成「播放器设置」和「媒体库设置」两组（Windows、Mac 与 Android；iPad／iPhone 的设置页也一样分组）。
- **海报转场（Windows、Mac 与 Android）：** 点海报后直接飞向详情页，页面按时出现时约 0.6–0.7 秒落地；返回海报墙时不再出现空行。Windows 重启后第一次转场也不用再等着色器编译。Android 10 月 24 日更新的安装包让海报先落地再打开新页面，飞行途中不再卡顿，并换上黑金 Tigerest 图标。
- **弹幕不遮字幕：** 底部弹幕改为滚动显示，画面底部 20% 留给字幕（Windows、Mac、iPad 与 Apple TV）。
- **iPad 与 iPhone：** iPad 版改为 iPhone／iPad 通用包 `universal.ipa`，作为新应用安装（见[安装与更新](https://github.com/Tigerest/Tigerest-Theater/wiki/Installation#ipad--iphone)）；转屏后画面正确铺满；开着 RIFE 持续掉帧时会提示；海报转场改用桌面流程，约 0.6 秒落地；从屏幕左边缘右滑即可返回上一层。
- **Apple TV：** 返回键先收起控制栏；海报墙可以排序和搜索，并显示观看进度；文字字幕放大约 15%。

## 2.9.3 更新了什么

- **HDR：** Windows 播放 HDR 片源时自动开启系统 HDR 并以 HDR10 输出；Android 在 HDR 屏幕上直接输出 HDR，开始播放时提示 HDR／SDR 输出方式。见[播放与画质](https://github.com/Tigerest/Tigerest-Theater/wiki/Playback#hdr-播放)。
- **更新提醒：** 有新版本时每次打开软件弹窗一次，可从 GitHub、夸克网盘或百度网盘获取，或忽略本次更新。见[安装](https://github.com/Tigerest/Tigerest-Theater/wiki/Installation#应用内更新)。
- **Windows 卡死报告：** 播放器卡住或启动超时时自动发送故障报告给服务器管理员，可在客户端设置中关闭。
- **苹果三端（由 2.8.0 直接升级）：** Mac、iPad 与 Apple TV 支持 Jellyfin 并记住连接过的服务器；Mac 与 iPad 在 HDR 屏幕上直接输出 HDR10／杜比视界；Mac 的更新提醒与 Windows 相同。见[服务器与登录](https://github.com/Tigerest/Tigerest-Theater/wiki/Server)和[播放与画质](https://github.com/Tigerest/Tigerest-Theater/wiki/Playback#hdr-播放)。
- **iPad 与 Apple TV：** iPad 上 10 位 SDR 片源开启 RIFE 后长时间播放不再持续掉帧，并支持妙控键盘快捷键；iPad 和 Apple TV 戴 AirPods 时多声道音轨都可用空间音频。见 [RIFE 补帧](https://github.com/Tigerest/Tigerest-Theater/wiki/RIFE)。

## 2.9.1 更新了什么（Windows、Android）

- **Jellyfin 默认主题：** 服务器提供的自定义 CSS 默认禁用，按 Jellyfin 默认主题显示；在 Jellyfin「显示」设置里取消勾选「禁用服务器提供的自定义 CSS」即可恢复。
- **详情页与动画：** Jellyfin 手机详情页顶部显示横向背景图；Android 上海报飞行动画不再卡顿；Emby 手机竖屏单集页的顶部图片完整显示，从作品进单集的动画正常落地。
- **细节修复：** 海报圆角外不再露出深色直角，触屏设备上标签栏下方不再出现滚动条；在首页横滑海报不再误切到「我的最爱」标签。

## 2.9.0 更新了什么（Windows、Android）

- **Jellyfin 服务器：** 在「自建服务器」里填写 Jellyfin 地址，用该服务器账号登录。已实测 Jellyfin 10.9.11、10.10.7、10.11.0、10.11.11 与 12.2。见[服务器与登录](https://github.com/Tigerest/Tigerest-Theater/wiki/Server)。
- **服务器列表与「客户端」菜单：** 连接过的自建服务器记在切换服务器页面，点卡片即可切换；顶栏的 MPV 设置和切换服务器合并为「客户端」菜单。
- **Windows 花屏修复：** 首页轮播空闲、窗口被遮挡时偶发的整页花屏和闪屏已修复。
- **首页与媒体库：** 轮播换作品时交叉淡化；进入媒体库时整页飞入。
- **Android 折叠屏：** 在外屏启动后，Jellyfin 媒体库和详情页的布局不再错乱，媒体库滚动更流畅。
- **首页重复作品：** 同一部作品的两个条目合并为一张卡（原定 2.8.1，并入本版）。

苹果三端的 Jellyfin 支持随 2.9.3 发布。

## 2.8.0 更新了什么

- **一起看：** 登录大河服务器后，可以和朋友组一个房间同时观看同一部影片，每个房间最多 4 人。所有成员都可以播放、暂停、拖动和换片，各客户端自动对齐进度。Windows、Mac、Android、iPad 可用，Apple TV 暂不支持。见[一起看](https://github.com/Tigerest/Tigerest-Theater/wiki/Watch-Together)。
- **评论账号自助修改：** 独立评论账号可以在「评论账号」里修改显示昵称和密码；注册和改密码时要再输入一次密码确认。见[公共评论](https://github.com/Tigerest/Tigerest-Theater/wiki/Community)。
- **首页媒体夹：** 「首页 → 首页媒体夹」可以隐藏媒体夹、调整顺序，按服务器和账号保存在本机。见[播放与设置](https://github.com/Tigerest/Tigerest-Theater/wiki/Playback#首页媒体夹)。
- **播放修复：** 服务器给出的播放地址不带令牌时不再报 401；播放请求 302 跳转到其他主机时不再把令牌带过去。
- **iPad：** 持续补帧更稳定；开启 RIFE 时，一起看不再反复微调倍速打断补帧。
- **苹果三端首页：** 修复同一作品在首页出现两次。

2.6.1 起 Windows 网页界面按屏幕刷新率运行，并新增 iPad 客户端；2.7.0 起首页「继续观看」按观看记录排序，兼容 Emby 4.8–4.10 和 .strm 媒体库，并补充了 Apple TV 首版。完整记录见[更新记录](https://github.com/Tigerest/Tigerest-Theater/blob/main/CHANGELOG.md)。

**已知问题：** 不开补帧、使用默认的「显示器重采样」时，部分 Windows 高刷新率环境下窗口播放可能持续卡顿、增加输出丢帧，而全屏正常。2.9.5.1 仍未修复；遇到此现象请先使用全屏播放。详见[故障排查](https://github.com/Tigerest/Tigerest-Theater/wiki/Troubleshooting)。评论服务已停用旧的专属评论接口，2.9.4 及更早版本中大河用户无法发表或回复评论，升级到 2.9.5 后恢复。

## 各平台功能范围

| 功能 | Windows | Apple Silicon Mac | Android | iPad / iPhone | Apple TV |
| --- | --- | --- | --- | --- | --- |
| Emby／Jellyfin 浏览、MPV 播放、弹幕、公共评论 | 支持 | 支持 | 支持 | 支持 | 支持，原生电视界面；公共评论需已有账号 |
| HDR 直接输出 | 自动开启系统 HDR，HDR10 输出 | 支持 HDR 的屏幕上输出 | 支持 HDR 的屏幕上输出 | 支持 HDR 的屏幕上输出 | 未专门适配 |
| 一起看 | 支持 | 支持 | 支持 | 支持 | 暂无 |
| 画质预设 | 三档桌面预设 | 三档桌面预设 | 使用 Android 可用设置 | 支持 | 原生、轻量增强、完整桌面滤镜 |
| RIFE 补帧 | NVIDIA 可选扩展 | 随包，Core ML / Metal | 暂无 | 随包，1080p 8／10 位 SDR 固定两倍 | 暂无 |
| 下载与离线媒体 | 支持 | 支持 | 暂无 | 支持 | 暂无 |
| 应用内更新 | 下载并安装 | 下载 DMG 后替换应用 | 下载并交给系统安装器 | 只检查和提示 | 暂无 |
| 安装包签名 | 未做 Authenticode 签名 | 临时签名，未公证 | 正式签名 | 未签名，需自行签名 | 未签名，需自行签名 |

具体安装包和验证范围以[对应版本发行页](https://github.com/Tigerest/Tigerest-Theater/releases)为准。遇到问题先看[故障排查](https://github.com/Tigerest/Tigerest-Theater/wiki/Troubleshooting)；想了解实现方式见[技术原理](https://github.com/Tigerest/Tigerest-Theater/wiki/Architecture)。项目与支持入口见[项目主页](https://github.com/Tigerest/Tigerest-Theater)和[作者 B站](https://space.bilibili.com/12562485)。
