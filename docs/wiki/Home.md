# Tigerest Theater 使用教程

这里是 EMBY 大河版的中文使用说明，对应 Windows、Android 2.8.1 与 Mac、iPad、Apple TV 2.8.0。客户端支持 Windows、Apple Silicon Mac、Android、iPad 和 Apple TV；播放内容和访问权限来自你连接的 Emby 服务器。

## 第一次使用

1. 按设备选择并安装[正式版本](https://github.com/Tigerest/Tigerest-Theater/releases/latest)：见[安装与更新](https://github.com/Tigerest/Tigerest-Theater/wiki/Installation)。
2. 选择大河专属入口或填写自己的 Emby 地址：见[服务器与登录](https://github.com/Tigerest/Tigerest-Theater/wiki/Server)。
3. 登录服务器，打开一部作品并播放：见[播放与设置](https://github.com/Tigerest/Tigerest-Theater/wiki/Playback)。Apple TV 的操作方式不同，见 [Apple TV](https://github.com/Tigerest/Tigerest-Theater/wiki/Apple-TV)。
4. 根据需要选择字幕、检查弹幕。先用默认设置播放，再调整画质或启用补帧。
5. 自建 Emby 用户想看公共评论时，打开详情页的「评论账号」完成独立注册或登录。

## 按任务查找教程

| 任务 | 页面内容 |
| --- | --- |
| [安装与更新](https://github.com/Tigerest/Tigerest-Theater/wiki/Installation) | 系统要求、安装版与便携版、iPad 与 Apple TV 签名安装、覆盖更新、SHA-256 |
| [服务器与登录](https://github.com/Tigerest/Tigerest-Theater/wiki/Server) | 地址格式、反向代理路径、切换服务器、媒体权限、两种账号 |
| [一起看](https://github.com/Tigerest/Tigerest-Theater/wiki/Watch-Together) | 创建和加入房间、一起开始、同步方式、换片、房主操作 |
| [公共评论与头像](https://github.com/Tigerest/Tigerest-Theater/wiki/Community) | 注册、修改昵称和密码、发言与回复、头像同步 |
| [消息与私人报错](https://github.com/Tigerest/Tigerest-Theater/wiki/Messages-and-Reports) | 回复、我的发言、报错、日志附件、修复通知与已读状态 |
| [弹幕匹配与纠正](https://github.com/Tigerest/Tigerest-Theater/wiki/Danmaku) | 自动匹配、手动选集、共享校准、来源屏蔽与偏移 |
| [播放与设置](https://github.com/Tigerest/Tigerest-Theater/wiki/Playback) | 设置入口、首页媒体夹、声音、画质、快捷键、Android 与 iPad 手势 |
| [字幕](https://github.com/Tigerest/Tigerest-Theater/wiki/Subtitles) | 选轨、外置字幕、时间偏移、样式与 ASS 特效 |
| [RIFE 补帧](https://github.com/Tigerest/Tigerest-Theater/wiki/RIFE) | Windows 扩展、Mac 与 iPad 内置补帧、目标帧率、性能检查 |
| [下载与离线媒体](https://github.com/Tigerest/Tigerest-Theater/wiki/Downloads) | 下载任务、离线播放、数据保留与权限 |
| [Apple TV](https://github.com/Tigerest/Tigerest-Theater/wiki/Apple-TV) | 电视端登录、遥控器操作、字幕、弹幕、评论与画质 |
| [故障排查](https://github.com/Tigerest/Tigerest-Theater/wiki/Troubleshooting) | 按现象定位问题、日志目录、提交有效反馈 |
| [常见问题](https://github.com/Tigerest/Tigerest-Theater/wiki/FAQ) | 平台区别、账号范围、补帧与共享功能的常见疑问 |
| [技术原理](https://github.com/Tigerest/Tigerest-Theater/wiki/Architecture) | 各客户端的实现与架构、播放链路、一起看同步、评论和弹幕的数据流 |

## 2.8.1 更新了什么（Windows、Android）

- **首页重复作品：** 服务器上同一部作品有两个条目时，首页按 Emby 的作品身份合并为一张卡，保留最近一次播放的继续观看进度；同名的不同作品不合并。Mac、iPad 与 Apple TV 在 2.8.0 已修复。

## 2.8.0 更新了什么

- **一起看：** 登录大河服务器后，可以和朋友组一个房间同时观看同一部影片，每个房间最多 4 人。所有成员都可以播放、暂停、拖动和换片，各客户端自动对齐进度。Windows、Mac、Android、iPad 可用，Apple TV 暂不支持。见[一起看](https://github.com/Tigerest/Tigerest-Theater/wiki/Watch-Together)。
- **评论账号自助修改：** 独立评论账号可以在「评论账号」里修改显示昵称和密码；注册和改密码时要再输入一次密码确认。见[公共评论](https://github.com/Tigerest/Tigerest-Theater/wiki/Community)。
- **首页媒体夹：** 「首页 → 首页媒体夹」可以隐藏媒体夹、调整顺序，按服务器和账号保存在本机。见[播放与设置](https://github.com/Tigerest/Tigerest-Theater/wiki/Playback#首页媒体夹)。
- **播放修复：** 服务器给出的播放地址不带令牌时不再报 401；播放请求 302 跳转到其他主机时不再把令牌带过去。
- **iPad：** 持续补帧更稳定；开启 RIFE 时，一起看不再反复微调倍速打断补帧。
- **苹果三端首页：** 修复同一作品在首页出现两次。

2.6.1 起 Windows 网页界面按屏幕刷新率运行，并新增 iPad 客户端；2.7.0 起首页「继续观看」按观看记录排序，兼容 Emby 4.8–4.10 和 .strm 媒体库，并补充了 Apple TV 首版。完整记录见[更新记录](https://github.com/Tigerest/Tigerest-Theater/blob/main/CHANGELOG.md)。

**已知问题：** 部分 Windows 高刷新率环境下，窗口播放可能持续卡顿、增加输出丢帧，而全屏正常。2.8.1 仍未修复；遇到此现象请先使用全屏播放。详见[故障排查](https://github.com/Tigerest/Tigerest-Theater/wiki/Troubleshooting)。

## 各平台功能范围

| 功能 | Windows | Apple Silicon Mac | Android | iPad | Apple TV |
| --- | --- | --- | --- | --- | --- |
| Emby 浏览、MPV 播放、弹幕、公共评论 | 支持 | 支持 | 支持 | 支持 | 支持，原生电视界面；公共评论需已有账号 |
| 一起看 | 支持 | 支持 | 支持 | 支持 | 暂无 |
| 画质预设 | 三档桌面预设 | 三档桌面预设 | 使用 Android 可用设置 | 支持 | 原生、轻量增强、完整桌面滤镜 |
| RIFE 补帧 | NVIDIA 可选扩展 | 随包，Core ML / Metal | 暂无 | 随包，1080p 固定两倍 | 暂无 |
| 下载与离线媒体 | 支持 | 支持 | 暂无 | 支持 | 暂无 |
| 应用内更新 | 下载并安装 | 下载 DMG 后替换应用 | 下载并交给系统安装器 | 只检查和提示 | 暂无 |
| 安装包签名 | 未做 Authenticode 签名 | 临时签名，未公证 | 正式签名 | 未签名，需自行签名 | 未签名，需自行签名 |

具体安装包和验证范围以[对应版本发行页](https://github.com/Tigerest/Tigerest-Theater/releases)为准。遇到问题先看[故障排查](https://github.com/Tigerest/Tigerest-Theater/wiki/Troubleshooting)；想了解实现方式见[技术原理](https://github.com/Tigerest/Tigerest-Theater/wiki/Architecture)。项目与支持入口见[项目主页](https://github.com/Tigerest/Tigerest-Theater)和[作者 B站](https://space.bilibili.com/12562485)。
