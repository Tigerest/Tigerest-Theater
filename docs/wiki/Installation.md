# 安装与更新

## 选择正确的包

从[正式发行页](https://github.com/Tigerest/Tigerest-Theater/releases/latest)下载，基础包已经包含 MPV 与运行库。下面以 2.9.5 的文件名示例说明；安装步骤也适用于后续同类正式包。

| 设备 | 包名 | 最低要求 |
| --- | --- | --- |
| Windows 安装版 | TigerestTheater-2.9.5-x64.exe | Windows 10 1903+ 或 Windows 11，x64 |
| Windows 便携版 | TigerestTheater-2.9.5-x64.zip | 同上 |
| Android | TigerestTheater-2.9.5-android.apk | Android 15+，arm64-v8a / x86_64 |
| Apple Silicon Mac | TigerestTheater-2.9.5-arm64.dmg | macOS 26+，M 系列 |
| iPad / iPhone | TigerestTheater-2.9.5-universal.ipa（2.9.3 及以前为 ipad.ipa） | iPadOS / iOS 26+，需要自行签名 |
| Apple TV | TigerestTheater-2.9.5-tvos.ipa | tvOS 26+，需要自行签名 |

Windows 安装版适合日常使用，由安装器管理程序目录；便携版适合把程序与配置放在同一个文件夹。Mac 正式附件目前仅提供 Apple Silicon 版本。Android 的系统版本和处理器架构必须同时满足要求。iPad / iPhone 通用包和 Apple TV 的 IPA 是两个不同的设备包，不能互换。

无法访问 GitHub 时，可从固定的[夸克网盘](https://pan.quark.cn/s/88e6f7a795b4)或[百度网盘](https://pan.baidu.com/s/58azzOU4piiB3miyZqA1dig)分享文件夹下载 Windows／Android 安装包（Mac、iPad 与 Apple TV 的安装包目前只在 GitHub 发行页提供）。每个版本一个子文件夹，附件与发行页相同，请用其中的 `SHA256SUMS.txt` 校验。

## Windows 安装版

1. 下载 EXE。升级时先退出运行中的客户端；若启用了系统托盘，还要从托盘退出。
2. 运行安装器并按向导完成安装，升级时使用原来的安装位置。
3. 启动客户端，连接 Emby 服务器。首次安装不需要另外下载 MPV、Python 或 CUDA Toolkit。
4. NVIDIA RIFE 扩展按需要另行安装，见 [RIFE 教程](https://github.com/Tigerest/Tigerest-Theater/wiki/RIFE)。

安装包目前没有 Authenticode 签名。遇到系统来源提示时，先核对下载来自本项目发行页以及校验值，再决定是否继续。

## Windows 便携版

1. 把 ZIP 完整解压到可写目录，运行其中的 `Tigerest Theater.exe`。
2. 保留随包的子目录和运行库。只取出一个 EXE 无法构成完整客户端。
3. 更新前完全退出，备份旧目录中的 `data`。
4. 将新版完整解压到新文件夹，再把原有 `data` 放回新版目录；确认正常后再自行处理旧程序目录。

`data` 包含配置档及其数据。直接删除它会影响登录、设置、缓存、离线文件或已有扩展；更新不需要清空它。不同位置的便携副本通常各自使用本地数据，不要把它们当成同一个配置。

## macOS

1. 下载 arm64 DMG，打开后将应用拖入「应用程序」。
2. 更新前退出旧应用，再替换「应用程序」中的原应用。
3. 从「应用程序」启动。当前使用 ad-hoc 签名，尚未经过 Apple 公证；确认来源后，如被系统拦截，可在「系统设置 → 隐私与安全性」按提示允许打开。
4. RIFE 模型和插件随包提供，无需 Windows 的 NVIDIA 扩展。

不要把 Windows 扩展 ZIP 导入 Mac。Mac 的补帧范围与 Windows 不同，详见 [RIFE](https://github.com/Tigerest/Tigerest-Theater/wiki/RIFE)。

## Android

1. 下载 APK，通过系统安装器安装“大河影院”。
2. 系统可能要求允许当前浏览器或文件管理器安装应用，按系统页面授权。
3. 升级时使用本项目同签名正式 APK 覆盖安装，可保留应用数据。
4. 如果系统提示签名冲突，先确认当前装的是正式版还是调试版、文件是否来自本项目。不要为了尝试更新立即卸载已有应用，卸载可能清除数据。

应用内更新交给系统安装器时，需要允许“大河影院”安装应用。取消系统安装后仍可返回客户端重试。

## iPad / iPhone

1. 下载 `universal.ipa`（2.9.3 及以前叫 `ipad.ipa`）。它是完整的设备版应用，但**没有签名**，不能直接在“文件”里点开安装，也不是 App Store 或 TestFlight 安装包。
2. 用自己的 Apple 身份签名后安装：已有侧载签名工具时，导入 IPA 并用自己的账号签名；也可以在 Mac 上用 Xcode 从源码构建安装，见 [iPad / iPhone 安装与构建](https://github.com/Tigerest/Tigerest-Theater/blob/main/docs/apple/INSTALL.md)。
3. 免费账号的签名有有效期，需要按 Apple 的规则续签。
4. 更新时重新签名并覆盖安装，保持原来的应用标识和签名身份。不要先卸载，以免丢失配置和离线媒体。
5. 2.9.4 起应用标识改为 `top.tigerest.theater.universal`，安装包改名为 `universal.ipa`。系统会把它当成新应用：不会覆盖 2.9.3 及更早的 iPad 版，登录、服务器列表、设置和离线媒体不会迁移，需要重新登录；确认新版正常后可以手动删除旧版。
6. 2.9.5 沿用同一个应用标识，可以覆盖 2.9.4 安装。大河专属服务器的公网连接从 2.9.5 起改用加密连接，升级后第一次连接需要重新登录一次 Emby，服务器列表、设置和离线媒体保留。

IPA 不含作者的签名、设备名单或证书。应用内可以检查新版本、阅读说明和忽略本次更新，但不会自动替换安装。

## Apple TV

1. 下载 `tvos.ipa`，同样没有签名，需要为自己已配对的 Apple TV 签名后安装；或者用 Xcode 从源码构建安装，见 [Apple TV 安装与构建](https://github.com/Tigerest/Tigerest-Theater/blob/main/apple/TV/README.md)。
2. 更新时重新签名并覆盖安装，不要先卸载。
3. Apple TV 没有应用内更新检查，新版本请到发行页查看。

使用方法见 [Apple TV](https://github.com/Tigerest/Tigerest-Theater/wiki/Apple-TV)。

## 应用内更新

Windows、Mac、Android 和 iPad／iPhone 每次启动会在后台检查新正式版。只有版本更高且包含对应平台安装包时，右上角更新图标才显示红点。

Windows、Mac 和 Android 有新版本时，每次打开软件弹出一次更新窗口。检查在后台进行，不拖慢启动；如果你已经开始操作时检查才完成，这次不打扰，结果留到下次打开时立刻显示，同时在后台重新核对一次。

更新窗口里可以选择：

- 「直接下载」：下载、校验后安装（见下文）。先经 GitHub 下载加速镜像 gh-proxy.com 下载，连不上或出错时依次换用 ghproxy.net 和 GitHub 原址；进度里显示当前来源。
- 「备用下载」：展开「夸克网盘」「百度网盘」两个按钮（直接下载失败后自动展开），在浏览器中打开网盘分享里这个版本的文件夹，登录网盘后下载，适合直接下载不成功时手动下载安装包（网盘里目前只有 Windows／Android 安装包，Mac 请从 GitHub 获取）。Android 上夸克的手机网页不能直接打开子文件夹，会停在分享首页，再依次点开 `Tigerest-Theater` 和版本号文件夹；装有百度网盘应用时，百度网盘链接可能由应用接管。找不到版本文件夹时打开整个分享。
- 「忽略本次更新」：直到下一个新版本发布前不再弹窗。
- 「稍后」：本次运行不再弹出，下次打开软件再提示。

在「客户端」设置中可以关闭「启动时检查更新」（同时不再弹窗），或点击「检查客户端更新」；手动检查也会包含此前忽略的版本。

下载支持暂停和继续；退出后再次检查同一版本可以续传。网络中断会自动重连，连续多次没有新进度后才显示失败。服务器文件变化、无法续传或缓存损坏时，客户端会重新下载。

下载完成后会核验大小和 SHA-256，校验值只取自 GitHub 官方接口，镜像只负责传输；经镜像下载的文件校验不通过时，自动改从 GitHub 原址重新下载一次。Windows 安装版从 2.9.4 起自动安装：大河影院会自己关闭，装好后自动重新打开，不用手动关掉旧版；装在「所有用户」目录时会出现一次系统权限提示，选「是」即可（从更早版本升级时仍是升级向导）。便携版打开 ZIP 后仍需退出并替换程序；Mac 打开 DMG 后替换应用。Android 从 2.9.4 起直接交给系统安装，系统会弹出安装提示，第一次还需要允许大河影院安装应用；安装时应用会被系统关闭，装好后从桌面重新打开（Android 不允许应用在更新后自己启动）。如果正在播放，自动安装会等播放结束。完成下载不等于安装完成。iPad／iPhone 只提示新版本，需要按上面的方法重新签名安装；Apple TV 没有应用内更新检查。

早期 Windows 版本的内置更新若始终下载失败，请手动下载当前安装包并覆盖安装一次。暂时无法检查更新不会阻止浏览或播放。

## 核对 SHA-256

2.9.5 起发行页只有一份校验清单 `TigerestTheater-2.9.5-SHA256SUMS.txt`，覆盖 Windows、Android、Mac、iPhone／iPad 与 Apple TV 的全部文件（2.9.4 及以前，Mac、iPad 和 Apple TV 的文件另列在 `APPLE-SHA256SUMS.txt`）。先找到文件名对应的摘要，再与本机结果对照。

Windows PowerShell 示例：

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath 'C:\Downloads\TigerestTheater-2.9.5-x64.exe'
```

macOS 终端示例：

```sh
shasum -a 256 ~/Downloads/TigerestTheater-2.9.5-arm64.dmg
```

摘要应完全相同，大小写不影响比较。如果不同，重新下载该文件；不要使用校验失败的包继续更新。

下一步：[连接服务器](https://github.com/Tigerest/Tigerest-Theater/wiki/Server)。
