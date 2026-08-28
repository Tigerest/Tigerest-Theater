# Tigerest Theater / EMBY 大河版

面向 Windows 10/11 与 macOS 15+ 的非官方 Emby 桌面客户端。媒体库界面来自当前 Emby Server Web UI，播放由内嵌 libmpv 接管。

## 第一版能力

- 默认连接大河 Emby 服务器，支持内外网地址与标准 Emby Connect 入口。
- 登录、媒体浏览、搜索、视频/音频播放、播放队列、字幕、远程控制与播放进度回传。
- 可暂停、恢复和删除的原生下载管理，以及断网离线索引和 libmpv 回放。
- “大河内置”与“系统 MPV 配置”两种模式；后者自动读取 Windows `%APPDATA%\mpv`，或 macOS `~/.config/mpv` / `~/Library/Application Support/mpv`。
- 内置 uosc、uosc_danmaku、中文字体，以及“默认（Anime AA 高强度）”“真人影视高画质”“激进测试（Anime4K 完整链）”三套 Shader 预设；可用 UOSC 菜单或 Alt+1～3 原位切换并核验实际链路。
- 每个客户端配置档独立保存设置、缓存、日志、MPV 配置与离线文件。

## 构建

- Windows：参见 [`dev/windows/README.md`](dev/windows/README.md)。
- macOS：参见 [`dev/macos/README.md`](dev/macos/README.md)。

Windows 打包目标：

```powershell
cmake --build build --target windows_all
```

macOS 15+ 打包：

```sh
dev/macos/setup.sh
dev/macos/build.sh
dev/macos/test.sh
dev/macos/bundle.sh
```

本项目是非官方 Emby 客户端，与 Emby LLC 无隶属关系。第三方组件许可见源码树和安装包内对应文件。
