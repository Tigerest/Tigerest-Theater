# 引用来源与鸣谢

Tigerest Theater 建立在许多开源项目之上。这一页列出客户端直接使用、改造或参考的主要项目，以及它们用在哪里。这里只是概览：准确的版本、来源提交、哈希和完整许可证文本，以仓库和发行包里的文件为准：

- 桌面（Windows 与 Mac）：[licenses.txt](https://github.com/Tigerest/Tigerest-Theater/blob/main/resources/misc/licenses.txt)，以及各插件、着色器目录里的许可证文件和文件头
- Android：[licenses 目录](https://github.com/Tigerest/Tigerest-Theater/tree/main/android/app/src/main/assets/licenses)（[NOTICE.txt](https://github.com/Tigerest/Tigerest-Theater/blob/main/android/app/src/main/assets/licenses/NOTICE.txt) 说明原生库的来源）
- iPhone、iPad 与 Apple TV：[依赖锁定文件](https://github.com/Tigerest/Tigerest-Theater/blob/main/apple/dependencies.lock.json)和[字幕字体说明](https://github.com/Tigerest/Tigerest-Theater/blob/main/apple/Resources/SubtitleFonts/README.md)
- Windows NVIDIA 补帧扩展：[extension-NOTICE.txt](https://github.com/Tigerest/Tigerest-Theater/blob/main/dev/windows/rife/extension-NOTICE.txt)

## 客户端基础

| 项目 | 用在哪里 | 许可证 |
| --- | --- | --- |
| [Jellyfin Desktop](https://github.com/jellyfin/jellyfin-desktop) | Windows 与 Mac 客户端的 Qt 架构和代码基础 | GPL v2 |
| mpvqt（KDE）、HIDRemote、LetsMove | 随 Jellyfin Desktop 带来的桌面组件：Qt 里的 MPV 画面、Mac 遥控器、Mac 移入「应用程序」提示 | LGPL 2.1／3；BSD；公有领域 |
| [Qt](https://www.qt.io/) 与 QtWebEngine | 桌面界面和网页层；Windows 与 Mac 使用打过补丁的 QtWebEngine，让网页动画跟随显示器刷新率 | LGPL v3（QtWebEngine 另可选 GPL v2 或更高版本） |
| [Emby](https://emby.media/) 与 [Jellyfin](https://jellyfin.org/) 网页端 | Windows、Mac、Android 和 iPad 的媒体库页面就是所连接服务器自带的网页端 | 随服务器 |
| [jellyfin-web](https://github.com/jellyfin/jellyfin-web) | 桌面部分界面文字的翻译 | GPL v2 |

## 播放核心

| 项目 | 用在哪里 | 许可证 |
| --- | --- | --- |
| [mpv](https://mpv.io/)（[源码](https://github.com/mpv-player/mpv)） | 各平台的播放内核 | GPL v2 或更高版本 |
| [FFmpeg](https://ffmpeg.org/) | 各平台的解码 | LGPL／GPL，视各平台的构建选项 |
| libass、libplacebo、dav1d、HarfBuzz、FreeType、FriBidi 等 | 字幕排版、GPU 渲染、AV1 解码 | 见各平台许可文件 |
| [mpv-winbuild-cmake](https://github.com/shinchiro/mpv-winbuild-cmake)（shinchiro） | Windows 的 libmpv；补帧用的 libmpv 也按这套配方加补丁自建 | 见上游 |
| [mpv-android](https://github.com/mpv-android/mpv-android) | Android 内置的 libmpv 与 JNI 桥，原样取自正式版 | MIT（JNI 桥） |
| [MPVKit](https://github.com/mpvkit/MPVKit) | iPhone、iPad 与 Apple TV 的 libmpv、FFmpeg 及依赖 | 使用 GPL 版二进制 |
| [MoltenVK](https://github.com/KhronosGroup/MoltenVK) | 在 Mac 和苹果设备上把 Vulkan 渲染转到 Metal | Apache 2.0 |

## 播放器界面与弹幕

| 项目 | 用在哪里 | 许可证 |
| --- | --- | --- |
| [uosc](https://github.com/tomasklaen/uosc)（tomasklaen） | 桌面播放器的控制界面 | LGPL v2.1 |
| [uosc_danmaku](https://github.com/Tony15246/uosc_danmaku)（Tony15246） | 桌面弹幕插件，本项目在它的基础上修改 | MIT |
| [rkscv/danmaku](https://github.com/rkscv/danmaku)、[lua-inflate](https://github.com/TohruMKDM/lua-inflate)、[OpenCC](https://github.com/BYVoid/OpenCC) | uosc_danmaku 里的弹幕渲染与 MD5、ZIP 解压、简繁转换 | 见插件目录 |
| [弹弹play](https://www.dandanplay.com/) | 弹幕搜索和下载沿用弹弹play 开放平台的接口格式 | — |
| mpv 自带的 stats.lua | 桌面播放器的统计信息面板 | GPL v2 |

## 画质着色器

桌面画质预设使用的着色器，iPad 与 Apple TV 的桌面预设也用同一套。

| 着色器 | 作者 | 许可证 |
| --- | --- | --- |
| [Anime4K](https://github.com/bloc97/Anime4K) | bloc97 | MIT |
| [ArtCNN](https://github.com/Artoriuz/ArtCNN) | João Chrisóstomo、Kacper Michajłow | MIT |
| CfL 色度预测 | João Chrisóstomo | MIT |
| [FSRCNNX](https://github.com/igv/FSRCNN-TensorFlow) | igv | LGPL v3 或更高版本 |
| SSimDownscaler、SSimSuperRes | igv | 见文件头 |
| [RAVU](https://github.com/bjin/mpv-prescalers) | bjin | LGPL v3 或更高版本 |
| KrigBilateral | Shiandow | LGPL v3 或更高版本 |

着色器的整理版本和参数说明参考 [mpv_PlayKit](https://github.com/hooke007/mpv_PlayKit)（hooke007）。

## AI 补帧（RIFE）

| 项目 | 用在哪里 | 许可证 |
| --- | --- | --- |
| [Practical-RIFE](https://github.com/hzwer/Practical-RIFE)（hzwer） | RIFE 补帧模型；Mac 与 iPad 上转换为 Core ML 运行 | MIT |
| [VapourSynth](https://github.com/vapoursynth/vapoursynth) | Windows 与 Mac 补帧的视频处理框架 | LGPL 2.1 或更高版本 |
| [vs-mlrt](https://github.com/AmusementClub/vs-mlrt)（AmusementClub） | Windows NVIDIA 补帧扩展的 TensorRT 推理和 ONNX 模型 | GPL v3 |
| NVIDIA TensorRT 与 CUDA | Windows NVIDIA 补帧扩展，原样分发 | NVIDIA 软件许可 |
| [Python](https://www.python.org/) | Windows 补帧扩展与 Mac 补帧运行 VapourSynth 脚本 | PSF |
| [miniz](https://github.com/richgel999/miniz) | Windows 解压补帧扩展包 | MIT |

## 字体

| 字体 | 用在哪里 | 许可证 |
| --- | --- | --- |
| [思源宋体](https://github.com/adobe-fonts/source-han-serif)（Adobe） | 桌面内置字体 | SIL OFL 1.1 |
| [思源黑体](https://github.com/adobe-fonts/source-han-sans)（Adobe） | iPad 与 Apple TV 的默认字幕字体 | SIL OFL 1.1 |

## Android 与其他

| 项目 | 用在哪里 | 许可证 |
| --- | --- | --- |
| Kotlin、AndroidX、[OkHttp](https://github.com/square/okhttp) | Android 客户端 | Apache 2.0 |
| [OpenSSL](https://www.openssl.org/) | Windows 的加密连接运行库 | Apache 2.0 |
| [Inno Setup](https://jrsoftware.org/isinfo.php) | Windows 安装程序 | Inno Setup 许可 |

## 许可证与源码

主项目使用 [GNU GPL v2](https://github.com/Tigerest/Tigerest-Theater/blob/main/LICENSE)，第三方组件按各自的许可证分发。每个正式版的发行页都附带客户端完整源码（`client-Sources.zip`）、Android 源码（`android-Sources.zip`）和 `RELEASE-MANIFEST.json`；Android 原生库的哈希记录在 [native-runtime.lock.json](https://github.com/Tigerest/Tigerest-Theater/blob/main/android/native-runtime.lock.json)，Windows 补帧扩展附带 VapourSynth 和 vs-mlrt 的原始源码。

上述名称和商标归各自所有者所有，本项目是非官方客户端，与它们没有隶属关系。

## 鸣谢

感谢以上项目的作者和贡献者，也感谢 Emby 与 Jellyfin 社区。感谢在 [GitHub Issue](https://github.com/Tigerest/Tigerest-Theater/issues)、[B站](https://space.bilibili.com/12562485)和客户端「上报问题」里反馈问题的用户。

项目维护：[大河李斯特（Tigerest）](https://github.com/Tigerest)；AI 辅助开发：Claude、Codex。
