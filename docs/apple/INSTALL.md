# iPad / iPhone 安装与构建

2.9.5 的系统要求为 iPadOS / iOS 26 及以后版本。发行附件 [`TigerestTheater-2.9.5-universal.ipa`](https://github.com/Tigerest/Tigerest-Theater/releases/download/v2.9.5/TigerestTheater-2.9.5-universal.ipa) 是 iPad 与 iPhone 通用的完整设备版应用，但**未签名，必须先用自己的 Apple 身份重签名才能安装**。它不含作者的个人开发签名、设备名单、证书或账号。不是 App Store 或 TestFlight 安装包，也不能直接在“文件”中点开安装。

已有侧载签名工具的用户，可以导入 IPA 并使用自己的账号签名。免费账号的签名有有效期，需要按 Apple 的规则续签。覆盖更新时保持原来的应用标识与签名身份；不要先卸载应用，以免丢失配置和离线媒体。

2.9.4 起应用标识改为 `top.tigerest.theater.universal`，安装包改名为 `universal.ipa`。系统会把它当成新应用：不会覆盖 2.9.3 及更早的 iPad 版，登录、服务器列表、设置和离线媒体不会迁移，需要重新登录；确认新版正常后可以手动删除旧版。

2.9.5 沿用同一个应用标识，可以覆盖 2.9.4 安装。大河专属服务器的公网连接从 2.9.5 起改用加密连接，升级后第一次连接需要重新登录一次 Emby，服务器列表、设置和离线媒体保留。

## 使用 Mac 与 Xcode 27

从源码构建可以直接使用 Xcode 的 Personal Team。首次需准备固定的 MPVKit 与 RIFE 依赖，详见[移植验证与构建记录](2026-10-14-ipad-feedback-verification.md)中的“构建与复现”。未准备 RIFE 依赖时仍可构建基础播放器，但不会提供补帧选项。

1. 选择 Xcode 27，运行 `python3 apple/tools/generate_project.py` 生成工程。
2. 打开 `apple/TigerestTheater.xcodeproj`，选择 TigerestTheater → Signing & Capabilities → Team，选自己的 Personal Team。
3. 选择已配对的 iPad 或 iPhone；首次配对、开发者模式及设备信任需在设备上确认。
4. 点击运行。后续可以通过已配对的无线设备连接覆盖安装；可用性取决于设备与 Mac 的连接状态。

账户和密码在 Xcode／设备上自行输入，不需要写进源码。个人签名配置保持本地，不提交或附加到发行包。

## 播放与更新

播放器支持定位、音量、亮度、长按倍速、锁定和季集选择；视频播放时隐藏系统状态栏。客户端主设置中提供画质预设与 RIFE。RIFE 默认关闭，当前为1920×1080、BT.709 SDR、23–30 fps输入和固定两倍输出；不支持的输入保留原帧。

应用内可以检查新版本、阅读说明和跳过版本。免费开发签名安装不提供应用内自动替换，更新需重新签名或通过 Xcode 覆盖安装。

## 生成无签名发行 IPA

先生成普通工程，以 Release、`generic/platform=iOS`、`CODE_SIGNING_ALLOWED=NO` 构建，再执行：

```sh
python3 apple/tools/package_ipa.py --app /path/to/Release-iphoneos/TigerestTheater.app --output /path/to/release
```

打包器只修改临时副本，验证设备架构、系统版本、普通入口、Web资源和RIFE模型，移除签名与描述文件，拒绝私钥和个人构建配置。输出校验报告明确区分包检查与真机播放测试。
